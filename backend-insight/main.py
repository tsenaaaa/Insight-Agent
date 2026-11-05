import os
import json
import uuid
from datetime import datetime
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware

from langchain_community.utilities import SQLDatabase
from langchain_groq import ChatGroq
from langchain_community.agent_toolkits import SQLDatabaseToolkit, create_sql_agent
from sqlalchemy import inspect, text

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

HISTORY_FILE = "chat_history.json"


def load_history():
    if not os.path.exists(HISTORY_FILE):
        return {}
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_history(data):
    with open(HISTORY_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


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
        now = datetime.now().isoformat()

        history = load_history()
        dataset_hist = history.setdefault(request.dataset_id, {})

        if conversation_id not in dataset_hist:
            dataset_hist[conversation_id] = {
                "title": request.question[:60],
                "created_at": now,
                "messages": []
            }

        conv = dataset_hist[conversation_id]
        conv["messages"].append({"role": "user", "content": request.question, "ts": now})
        conv["messages"].append({"role": "assistant", "content": answer, "ts": now})

        save_history(history)

        return QueryResponse(status="success", data=answer, conversation_id=conversation_id)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/conversations/{dataset_id}")
async def list_conversations(dataset_id: str):
    history = load_history()
    dataset_hist = history.get(dataset_id, {})
    result = []
    for cid, conv in dataset_hist.items():
        result.append({
            "id": cid,
            "title": conv.get("title", "Tanpa judul"),
            "created_at": conv.get("created_at", ""),
            "message_count": len(conv.get("messages", []))
        })
    result.sort(key=lambda x: x.get("created_at", ""), reverse=True)
    return result


@app.get("/conversations/{dataset_id}/{conversation_id}")
async def get_conversation(dataset_id: str, conversation_id: str):
    history = load_history()
    dataset_hist = history.get(dataset_id, {})
    conv = dataset_hist.get(conversation_id)
    if not conv:
        raise HTTPException(status_code=404, detail="Conversation tidak ditemukan.")
    return conv


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
