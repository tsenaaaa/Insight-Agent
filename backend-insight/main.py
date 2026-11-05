import os
import uuid
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware

from langchain_community.utilities import SQLDatabase
from langchain_groq import ChatGroq
from langchain_community.agent_toolkits import SQLDatabaseToolkit, create_sql_agent
from sqlalchemy import inspect, text, create_engine

load_dotenv()
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
DATABASE_URL = os.getenv("DATABASE_URL")

app = FastAPI(title="Insight-Agent API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DATASET_TABLES = {
    "dataset_1": ["tokopedia_reviews"],
    "dataset_2": ["amazon_sales"],
    "dataset_3": ["shopee_sales"]
}

engine = create_engine(DATABASE_URL)


def init_db():
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS chat_history (
                id TEXT PRIMARY KEY,
                dataset_id TEXT NOT NULL,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_chat_history_dataset_conv
            ON chat_history(dataset_id, conversation_id)
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_chat_history_conv
            ON chat_history(conversation_id)
        """))


init_db()


def save_message(dataset_id: str, conversation_id: str, role: str, content: str):
    with engine.begin() as conn:
        conn.execute(
            text("""
                INSERT INTO chat_history (id, dataset_id, conversation_id, role, content, created_at)
                VALUES (:id, :dataset_id, :conversation_id, :role, :content, :created_at)
            """),
            {
                "id": str(uuid.uuid4()),
                "dataset_id": dataset_id,
                "conversation_id": conversation_id,
                "role": role,
                "content": content,
                "created_at": datetime.now(timezone.utc),
            },
        )


def get_conversations(dataset_id: str):
    with engine.connect() as conn:
        result = conn.execute(
            text("""
                SELECT conversation_id,
                       MIN(created_at) as created_at,
                       COUNT(*) as message_count,
                       MIN(CASE WHEN role = 'user' THEN content END) as first_user_content
                FROM chat_history
                WHERE dataset_id = :dataset_id
                GROUP BY conversation_id
                ORDER BY created_at DESC
            """),
            {"dataset_id": dataset_id},
        )
        rows = result.fetchall()
    return [
        {
            "id": r[0],
            "title": (r[3] or "Tanpa judul")[:60],
            "created_at": r[1].isoformat() if r[1] else "",
            "message_count": r[2],
        }
        for r in rows
    ]


def get_messages(dataset_id: str, conversation_id: str):
    with engine.connect() as conn:
        result = conn.execute(
            text("""
                SELECT role, content, created_at
                FROM chat_history
                WHERE dataset_id = :dataset_id AND conversation_id = :conversation_id
                ORDER BY created_at ASC
            """),
            {"dataset_id": dataset_id, "conversation_id": conversation_id},
        )
        rows = result.fetchall()
    return [
        {"role": r[0], "content": r[1], "ts": r[2].isoformat() if r[2] else None}
        for r in rows
    ]


class QueryRequest(BaseModel):
    dataset_id: str
    question: str
    conversation_id: str | None = None


class QueryResponse(BaseModel):
    status: str
    data: str
    conversation_id: str


class TableColumn(BaseModel):
    name: str
    type: str


class TableSchema(BaseModel):
    name: str
    columns: list[TableColumn]


@app.get("/schema/{dataset_id}")
async def get_schema(dataset_id: str):
    target_tables = DATASET_TABLES.get(dataset_id)

    if not target_tables:
        raise HTTPException(status_code=400, detail="Dataset tidak valid.")

    try:
        db = SQLDatabase.from_uri(
            DATABASE_URL,
            include_tables=target_tables
        )

        inspector = inspect(db.engine)
        result = []
        for table_name in target_tables:
            columns = inspector.get_columns(table_name)
            result.append(TableSchema(
                name=table_name,
                columns=[TableColumn(name=c["name"], type=str(c["type"])) for c in columns]
            ))

        return {"tables": result}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/ask", response_model=QueryResponse)
async def ask_agent(request: QueryRequest):
    target_tables = DATASET_TABLES.get(request.dataset_id)

    if not target_tables:
        raise HTTPException(status_code=400, detail="Dataset tidak valid.")

    try:
        db = SQLDatabase.from_uri(
            DATABASE_URL,
            include_tables=target_tables
        )

        llm = ChatGroq(
            groq_api_key=GROQ_API_KEY,
            model_name="openai/gpt-oss-120b",
            temperature=0
        )

        toolkit = SQLDatabaseToolkit(db=db, llm=llm)
        agent_executor = create_sql_agent(
            llm=llm,
            toolkit=toolkit,
            verbose=True,
            agent_type="tool-calling"
        )

        response = agent_executor.invoke({"input": request.question})
        answer = response["output"]

        conversation_id = request.conversation_id or str(uuid.uuid4())

        save_message(request.dataset_id, conversation_id, "user", request.question)
        save_message(request.dataset_id, conversation_id, "assistant", answer)

        return QueryResponse(status="success", data=answer, conversation_id=conversation_id)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conversations/{dataset_id}")
async def list_conversations(dataset_id: str):
    return get_conversations(dataset_id)


@app.get("/conversations/{dataset_id}/{conversation_id}")
async def get_conversation(dataset_id: str, conversation_id: str):
    messages = get_messages(dataset_id, conversation_id)
    if not messages:
        raise HTTPException(status_code=404, detail="Conversation tidak ditemukan.")
    return {"messages": messages}


class PreviewRequest(BaseModel):
    dataset_id: str


@app.post("/preview-data")
async def preview_data(request: PreviewRequest):
    target_tables = DATASET_TABLES.get(request.dataset_id)
    if not target_tables:
        raise HTTPException(status_code=400, detail="Dataset tidak valid.")

    try:
        db = SQLDatabase.from_uri(DATABASE_URL, include_tables=target_tables)

        primary_table = target_tables[0]

        with db._engine.connect() as connection:
            result = connection.execute(text(f'SELECT * FROM "{primary_table}" LIMIT 20'))
            columns = list(result.keys())
            rows = [list(row) for row in result.fetchall()]

        return {
            "status": "success",
            "table_name": primary_table,
            "columns": columns,
            "rows": rows
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
