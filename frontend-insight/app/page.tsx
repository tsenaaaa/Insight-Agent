"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  Loader2,
  ShoppingCart,
  Store,
  Truck,
  Table,
  MessageCircle,
  Plus,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const DATASETS = [
  {
    id: "dataset_1",
    name: "Tokopedia Reviews",
    icon: ShoppingCart,
    preview: {
      columns: ["product_id", "product_name", "category", "price", "rating"],
      rows: [
        ["TKP-001", "Keyboard Mechanical RGB", "Elektronik", "450000", "4.8"],
        ["TKP-002", "Mouse Wireless 2.4GHz", "Elektronik", "125000", "4.9"],
        ["TKP-003", "Kopi Bubuk Arabica 200g", "F&B", "55000", "4.7"],
      ],
    },
  },
  {
    id: "dataset_2",
    name: "Amazon Sales",
    icon: Store,
    preview: {
      columns: ["order_id", "product_name", "qty", "sales", "ship_mode"],
      rows: [
        ["AMZ-1092", "Amazon Basics HDMI Cable", "2", "15.99", "Standard"],
        ["AMZ-1093", "Lint Remover for Laundry", "1", "9.50", "Same Day"],
        ["AMZ-1094", "Portable Mini Juicer", "5", "125.00", "First Class"],
      ],
    },
  },
  {
    id: "dataset_3",
    name: "Shopee Sales",
    icon: Truck,
    preview: {
      columns: ["item_id", "title", "item_category", "price_ori", "delivery"],
      rows: [
        ["SHP-991", "Silicone Phone Case", "Mobile & Accessories", "15000", "Jakarta Raya"],
        ["SHP-992", "LED Desk Lamp USB", "Home & Living", "85000", "Bandung"],
        ["SHP-993", "Pack of 5 Eyeliners", "Health & Beauty", "45000", "Surabaya"],
      ],
    },
  },
];

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

type Message = { role: "user" | "assistant"; content: string; ts?: string };
type Conversation = {
  id: string;
  title: string;
  created_at: string;
  message_count: number;
  messages?: Message[];
};

const IconMap: Record<string, typeof ShoppingCart> = {
  dataset_1: ShoppingCart,
  dataset_2: Store,
  dataset_3: Truck,
};

export default function Home() {
  const [activeDataset, setActiveDataset] = useState(DATASETS[0].id);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Record<string, Conversation[]>>({});
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const activeData = DATASETS.find((d) => d.id === activeDataset);

  const fetchConversations = useCallback(async (ds: string) => {
    try {
      const res = await fetch(`${API_BASE}/conversations/${ds}`);
      const data = (await res.json()) as Conversation[];
      setConversations((prev) => ({ ...prev, [ds]: data }));
      if (data.length > 0) {
        setActiveConvId(data[0].id);
        fetchMessages(ds, data[0].id);
      } else {
        setActiveConvId(null);
        setMessages((prev) => ({ ...prev, [ds]: [] }));
      }
    } catch (e) {
      console.error("Gagal memuat riwayat:", e);
    }
  }, []);

  const fetchMessages = useCallback(async (ds: string, cid: string) => {
    try {
      const res = await fetch(`${API_BASE}/conversations/${ds}/${cid}`);
      const data = await res.json();
      setMessages((prev) => ({ ...prev, [cid]: data.messages || [] }));
    } catch (e) {
      console.error("Gagal memuat pesan:", e);
    }
  }, []);

  useEffect(() => {
    fetchConversations(activeDataset);
  }, [activeDataset, fetchConversations]);

  useEffect(() => {
    if (activeConvId) {
      fetchMessages(activeDataset, activeConvId);
    }
  }, [activeConvId, activeDataset, fetchMessages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    setLoading(true);

    const optimisticId = activeConvId || `temp-${Date.now()}`;
    const userMsg: Message = { role: "user", content: q };
    setMessages((prev) => ({
      ...prev,
      [optimisticId]: [...(prev[optimisticId] || []), userMsg],
    }));

    try {
      const res = await fetch(`${API_BASE}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dataset_id: activeDataset,
          question: q,
          conversation_id: activeConvId || undefined,
        }),
      });
      const data = await res.json();

      if (res.ok && data.status === "success") {
        const cid = data.conversation_id;
        setActiveConvId(cid);

        const assistantMsg: Message = { role: "assistant", content: data.data };
        setMessages((prev) => ({
          ...prev,
          [cid]: [
            ...(prev[optimisticId] === prev[cid]
              ? prev[cid].filter((m) => m.role !== "user" || m.content !== q)
              : []),
            userMsg,
            assistantMsg,
          ],
        }));

        setConversations((prev) => {
          const list = prev[activeDataset] || [];
          const existing = list.find((c) => c.id === cid);
          if (existing) {
            const next = list.map((c) =>
              c.id === cid
                ? { ...c, title: q.slice(0, 60), message_count: c.message_count + 2 }
                : c
            );
            return {
              ...prev,
              [activeDataset]: [existing, ...next.filter((c) => c.id !== cid)],
            };
          }
          return {
            ...prev,
            [activeDataset]: [
              {
                id: cid,
                title: q.slice(0, 60),
                created_at: new Date().toISOString(),
                message_count: 2,
              },
              ...list,
            ],
          };
        });
        setQuery("");
      } else {
        setQuery(`Error: ${data.detail || "Gagal memproses data"}`);
      }
    } catch {
      setQuery("Error: Koneksi ke server backend terputus.");
    } finally {
      setLoading(false);
    }
  };

  const selectConversation = (ds: string, cid: string) => {
    setActiveConvId(cid);
  };

  const newConversation = () => {
    setActiveConvId(null);
    setQuery("");
  };

  const currentConvs = conversations[activeDataset] || [];
  const currentMsgs = messages[activeConvId || ""] || [];
  const activeConv = currentConvs.find((c) => c.id === activeConvId);

  return (
    <main className="min-h-screen bg-[#0A0A0A] text-neutral-300 font-sans flex flex-col">
      {/* Header */}
      <header className="w-full px-6 py-8 bg-[#0A0A0A] border-b border-neutral-900/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center space-y-2">
            <h1 className="text-3xl font-semibold text-white tracking-tight">Insight Agent</h1>
            <p className="text-sm text-neutral-500">Autonomous Data Analysis via Natural Language</p>
            <p className="text-xs text-neutral-600">by Abim Bimasena A.R.P</p>
          </div>
        </div>
      </header>

      {/* Body */}
      <div className="flex-1 w-full max-w-6xl mx-auto px-6 pb-12 space-y-8">
        {/* Dataset Toggle */}
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3 justify-center">
            {DATASETS.map((ds) => {
              const Icon = IconMap[ds.id] ?? MessageCircle;
              const isActive = activeDataset === ds.id;
              return (
                <button
                  key={ds.id}
                  type="button"
                  onClick={() => setActiveDataset(ds.id)}
                  className={`flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-medium transition-all duration-200 border ${
                    isActive
                      ? "bg-neutral-100 text-neutral-900 border-neutral-100 shadow-sm"
                      : "bg-neutral-900/50 text-neutral-400 border-neutral-800 hover:text-neutral-200 hover:border-neutral-700"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {ds.name}
                </button>
              );
            })}
          </div>

          {/* Preview Table */}
          <div className="bg-neutral-900/40 border border-neutral-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-3">
              <Table className="w-4 h-4 text-neutral-500" />
              <span className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
                Preview Skema: {activeData?.name}
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs text-neutral-300">
                <thead className="bg-neutral-800/40 text-neutral-400">
                  <tr>
                    {activeData?.preview.columns.map((col, idx) => (
                      <th key={idx} className="px-3 py-2 font-medium border-b border-neutral-800">
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800/50">
                  {activeData?.preview.rows.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-neutral-800/20 transition-colors">
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="px-3 py-2 whitespace-nowrap">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Chat Layout: History Left | Chat Right */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* History Sidebar */}
          <div className="lg:col-span-3 space-y-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-neutral-200">Riwayat Chat</h3>
              <button
                onClick={newConversation}
                className="flex items-center gap-1 text-xs text-neutral-400 hover:text-white underline"
              >
                <Plus className="w-3 h-3" /> Baru
              </button>
            </div>
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-2">
              {currentConvs.map((c) => (
                <button
                  key={c.id}
                  onClick={() => selectConversation(activeDataset, c.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition-all ${
                    activeConvId === c.id
                      ? "bg-neutral-700/60 border-neutral-600 text-white"
                      : "bg-neutral-900/30 border-neutral-800 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                  }`}
                >
                  <div className="font-medium text-neutral-200 truncate">{c.title}</div>
                  <div className="text-xs text-neutral-500">{c.message_count} pesan</div>
                </button>
              ))}
              {currentConvs.length === 0 && (
                <div className="text-xs text-neutral-500 text-center py-6">
                  Belum ada riwayat chat
                </div>
              )}
            </div>
          </div>

          {/* Chat Area */}
          <div className="lg:col-span-9 bg-neutral-900/40 border border-neutral-800 rounded-xl p-5 flex flex-col h-[70vh] min-h-[500px]">
            <div className="flex items-center gap-2 mb-4">
              <MessageCircle className="w-5 h-5 text-neutral-400" />
              <span className={`text-sm font-medium truncate ${activeConvId ? "text-neutral-200" : "text-neutral-500"}`}>
                {activeConvId
                  ? activeConv?.title || "Obrolan"
                  : "Pilih riwayat atau ketik untuk memulai obrolan baru."}
              </span>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 mb-4 pr-2">
              {(!activeConvId || currentMsgs.length === 0) && (
                <div className="text-center text-neutral-500 text-sm py-12">
                  {activeConvId
                    ? "Obrolan masih kosong. Ketik pertanyaan untuk memulai."
                    : "Pilih dataset, lalu ketik pertanyaan untuk memulai analisis data."}
                </div>
              )}
              {currentMsgs.map((m, i) => (
                <div
                  key={i}
                  className={`max-w-[85%] ${m.role === "user" ? "ml-auto text-right" : "mr-auto text-left"}`}
                >
                  <div
                    className={`inline-block px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                      m.role === "user"
                        ? "bg-neutral-700 text-white"
                        : "bg-neutral-800 border border-neutral-700 text-neutral-300"
                    }`}
                  >
                    {m.role === "assistant" ? (
                      <div
                        className="space-y-4 [&>p]:leading-relaxed [&_strong]:text-white [&_strong]:font-semibold [&_table]:w-full [&_table]:border-collapse [&_th]:border [&_th]:border-neutral-700 [&_th]:bg-neutral-800 [&_th]:p-2 [&_th]:text-left [&_th]:text-white [&_td]:border [&_td]:border-neutral-800 [&_td]:p-2"
                      >
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    ) : (
                      m.content
                    )}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="ml-auto max-w-[85%]">
                  <div className="bg-neutral-800 border border-neutral-700 text-neutral-300 inline-block px-4 py-3 rounded-2xl text-sm flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Mengetik...</span>
                  </div>
                </div>
              )}
            </div>

            <form onSubmit={handleSubmit} className="flex gap-2 border-t border-neutral-800 pt-4">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ketik pertanyaan tentang data ini..."
                className="flex-1 bg-neutral-900/60 border border-neutral-700 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-neutral-600 disabled:opacity-60"
                disabled={loading}
              />
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="bg-neutral-600 hover:bg-neutral-500 disabled:opacity-50 text-white px-5 py-3 rounded-xl text-sm font-medium transition-colors"
              >
                {loading ? (
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                ) : (
                  <Search className="w-4 h-4" />
                )}
              </button>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
