import { GoogleGenAI } from "@google/genai";

// Zero-config AI Gateway client
const ai = new GoogleGenAI();

export default async (req: Request) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers, status: 204 });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { headers, status: 405 });
  }

  try {
    const { prompt, systemInstruction, isJson } = await req.json();

    if (!prompt) {
      return new Response(JSON.stringify({ error: "Missing prompt" }), { headers, status: 400 });
    }

    // Call Gemini using AI Gateway
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: systemInstruction || "You are a helpful medical assistant for Trạm Y Tế Bát Xát.",
        responseMimeType: isJson ? "application/json" : "text/plain",
      }
    });

    const text = response.text || "";

    return new Response(JSON.stringify({ text }), { headers, status: 200 });
  } catch (err: any) {
    console.error("AI Gateway Error:", err);
    return new Response(JSON.stringify({ error: err.message || "AI Error" }), { headers, status: 500 });
  }
};

export const config = {
  path: "/api/ai",
};
