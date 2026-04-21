import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export interface MCQQuestion {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
}

export interface Recommendation {
  title: string;
  url: string;
}

export interface SummaryResult {
  content: string;
  recommendations: Recommendation[];
}

export const generateQuiz = async (sources: string[], topic: string): Promise<MCQQuestion[]> => {
  const context = sources.join("\n\n---\n\n");
  const prompt = `
    You are an expert nursing educator. Based ONLY on the following study materials, generate a quiz of 5 multiple-choice questions about "${topic}".
    
    Materials:
    ${context}
    
    Requirements:
    1. Questions must be strictly based on the provided material.
    2. Each question must have 4 options.
    3. Correct answer must be one of the options.
    4. Provide a clear explanation for the correct answer based on the source.
    5. Ensure high medical accuracy according to the sources provided.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            question: { type: Type.STRING },
            options: { type: Type.ARRAY, items: { type: Type.STRING } },
            correctAnswer: { type: Type.STRING },
            explanation: { type: Type.STRING }
          },
          required: ["question", "options", "correctAnswer", "explanation"]
        }
      }
    }
  });

  return JSON.parse(response.text || "[]");
};

export const generateSummary = async (sources: string[], topic: string): Promise<SummaryResult> => {
  const context = sources.join("\n\n---\n\n");
  const prompt = `
    You are an expert nursing tutor. Based ONLY on the following study materials, provide a comprehensive summary of the topic "${topic}".
    
    Materials:
    ${context}
    
    Additionally, provide 3-5 high-quality external study recommendations (articles, videos, or research papers) available on the internet that could further help the student. These recommendations should include a title and a URL.
    
    Requirements:
    1. The core theoretical summary must follow the source materials strictly.
    2. Use professional medical terminology as used in nursing.
    3. Recommendations should be from reputable scientific or educational domains (.edu, .gov, .org).
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          content: { type: Type.STRING, description: "The summary in Markdown format" },
          recommendations: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                url: { type: Type.STRING }
              },
              required: ["title", "url"]
            }
          }
        },
        required: ["content", "recommendations"]
      }
    }
  });

  return JSON.parse(response.text || "{}");
};
