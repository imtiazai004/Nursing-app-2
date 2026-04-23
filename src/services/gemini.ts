import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

export interface OmniAnalysisResult {
  quiz: MCQQuestion[];
  summary: SummaryResult;
}

export const performOmniAnalysis = async (sources: string[], topic: string): Promise<OmniAnalysisResult> => {
  const context = sources.join("\n\n---\n\n");
  const prompt = `
    You are an expert nursing educator and research tutor. Based ONLY on the following study materials, perform a complete analysis of the topic "${topic}".
    
    Materials:
    ${context}
    
    TASK 1: COMPREHENSIVE SUMMARY
    Provide a professional clinical summary of the topic. Use nursing terminology and follow the source materials strictly.
    Include 3-5 external study recommendations (titles + URLs) from reputable domains (.edu, .gov, .org).

    TASK 2: EXHAUSTIVE MCQ SET
    Generate a quiz of 20-25 high-quality multiple-choice questions. 
    Scan the entire document to ensure coverage of all key concepts.
    Each question must have 4 options, 1 correct answer, and a detailed clinical rationale.
    
    Requirements:
    - High medical accuracy.
    - No duplicate questions.
    - Professional Markdown formatting for the summary text.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          summary: {
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
          },
          quiz: {
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
        },
        required: ["summary", "quiz"]
      }
    }
  });

  return JSON.parse(response.text || "{}");
};

// Deprecated: Please use performOmniAnalysis to conserve API quota
export const generateQuiz = async (sources: string[], topic: string): Promise<MCQQuestion[]> => {
  const result = await performOmniAnalysis(sources, topic);
  return result.quiz;
};

// Deprecated: Please use performOmniAnalysis to conserve API quota
export const generateSummary = async (sources: string[], topic: string): Promise<SummaryResult> => {
  const result = await performOmniAnalysis(sources, topic);
  return result.summary;
};
