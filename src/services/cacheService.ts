import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { OmniAnalysisResult } from './gemini';

/**
 * Generates a unique stable hash for a topic and its sources.
 * Using SHA-256 for high collision resistance.
 */
async function generateCacheKey(topic: string, sources: string[]): Promise<string> {
  const normalizedTopic = topic.trim().toLowerCase();
  // Sort sources to ensure order doesn't change the hash
  const normalizedSources = [...sources].sort().join('||');
  const message = `${normalizedTopic}::${normalizedSources}`;
  
  const msgUint8 = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return hashHex;
}

export const getCachedAnalysis = async (topic: string, sources: string[]): Promise<OmniAnalysisResult | null> => {
  try {
    const key = await generateCacheKey(topic, sources);
    const cacheRef = doc(db, 'analysis_cache', key);
    const cacheSnap = await getDoc(cacheRef);
    
    if (cacheSnap.exists()) {
      console.log("🚀 Cache Hit: Loading results from Firestore Research Vault");
      return cacheSnap.data().result as OmniAnalysisResult;
    }
    return null;
  } catch (error) {
    console.warn("Cache Retrieval failed:", error);
    return null;
  }
};

export const saveToCache = async (topic: string, sources: string[], result: OmniAnalysisResult) => {
  try {
    const key = await generateCacheKey(topic, sources);
    const cacheRef = doc(db, 'analysis_cache', key);
    
    await setDoc(cacheRef, {
      topic: topic.trim().toLowerCase(),
      result,
      createdAt: serverTimestamp(),
      // We don't save the full source content in the cache document to save space,
      // the key is enough to prove we've seen this exact combination before.
    });
    console.log("📦 Analysis cached for future clinical students");
  } catch (error) {
    console.error("Cache Save Error:", error);
  }
};
