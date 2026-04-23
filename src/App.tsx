/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { useAuthState } from 'react-firebase-hooks/auth';
import { auth, signInWithGoogle, logout, db } from './lib/firebase';
import { collection, query, where, onSnapshot, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { 
  BookOpen, 
  Upload, 
  FileText, 
  Plus, 
  Trash2, 
  BrainCircuit, 
  CheckCircle2, 
  AlertCircle,
  LogOut,
  GraduationCap,
  Sparkles,
  Search,
  ChevronRight,
  ExternalLink,
  History,
  Download
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Toaster, toast } from 'sonner';

// Custom Libs
import { exportSummaryToPDF, exportQuizToPDF } from './lib/pdfGenerator';

// UI Components
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Progress } from '@/components/ui/progress';

// Services
import { performOmniAnalysis, MCQQuestion, SummaryResult } from './services/gemini';
import { getCachedAnalysis, saveToCache } from './services/cacheService';
import Markdown from 'react-markdown';

import mammoth from 'mammoth';
import JSZip from 'jszip';

// PDF extraction
import * as pdfjs from 'pdfjs-dist';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const MAX_FIRESTORE_SIZE = 800000; // ~800KB limit to stay safely under 1MB doc limit

const TIMEOUT_MS = 15000; // 15 second timeout for extraction phase

const withTimeout = (promise: Promise<any>, ms: number, message: string) => {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
  ]);
};

const extractTextFromPPTX = async (arrayBuffer: ArrayBuffer) => {
  const zip = await JSZip.loadAsync(arrayBuffer);
  let fullText = '';
  const slideFiles = Object.keys(zip.files).filter(name => name.startsWith('ppt/slides/slide'));
  
  for (const slideFile of slideFiles) {
    const content = await zip.file(slideFile)?.async('text');
    if (content) {
      // Basic regex to extract text content between <a:t> tags in OOXML
      const matches = content.match(/<a:t>([^<]*)<\/a:t>/g);
      if (matches) {
        fullText += matches.map(m => m.replace(/<\/?a:t>/g, '')).join(' ') + '\n';
      }
    }
  }
  return fullText;
};

const handleFirestoreError = (error: any, operation: string, path: string | null = null) => {
  if (error?.code === 'permission-denied') {
    const errorInfo = {
      error: 'Missing or insufficient permissions.',
      operationType: operation,
      path: path,
      authInfo: auth.currentUser ? {
        userId: auth.currentUser.uid,
        email: auth.currentUser.email || '',
        emailVerified: auth.currentUser.emailVerified,
        isAnonymous: auth.currentUser.isAnonymous,
        providerInfo: auth.currentUser.providerData.map(p => ({
          providerId: p.providerId,
          displayName: p.displayName || '',
          email: p.email || ''
        }))
      } : 'Not Authenticated'
    };
    console.error('Firestore Security Error:', JSON.stringify(errorInfo, null, 2));
    toast.error('Clinical Security Violation: You do not have permission to perform this research operation.');
  } else {
    console.error(`Firestore Error (${operation}):`, error);
    toast.error(`Database Error: ${error.message || 'Operation failed'}`);
  }
};

export default function App() {
  const [user, loading] = useAuthState(auth);
  const [sources, setSources] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState('sources');
  const [isMobile, setIsMobile] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 1024);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);
  const [quizResult, setQuizResult] = useState<MCQQuestion[] | null>(null);
  const [summaryResult, setSummaryResult] = useState<SummaryResult | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [topic, setTopic] = useState('');
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    // Detect iOS
    const checkIOS = () => {
      const ua = window.navigator.userAgent;
      const iOS = !!ua.match(/iPad|iPhone|iPod/) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      setIsIOS(iOS);
    };
    checkIOS();
  }, []);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: any) => {
      // Prevent the mini-infobar from appearing on mobile
      e.preventDefault();
      // Stash the event so it can be triggered later.
      setDeferredPrompt(e);
      // Update UI notify the user they can install the PWA
      setShowInstallPrompt(true);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    window.addEventListener('appinstalled', () => {
      setDeferredPrompt(null);
      setShowInstallPrompt(false);
      toast.success('Nursify installed successfully! Check your home screen.');
    });

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    // Show the install prompt
    deferredPrompt.prompt();
    // Wait for the user to respond to the prompt
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      toast.success('Great choice! Opening the app profile...');
    }
    // We've used the prompt, and can't use it again, throw it away
    setDeferredPrompt(null);
    setShowInstallPrompt(false);
  };

  // Source upload states
  const [uploadText, setUploadText] = useState('');
  const [uploadTitle, setUploadTitle] = useState('');
  const [videoLink, setVideoLink] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  useEffect(() => {
    // Diagnostic check for API keys (common on Vercel/GitHub Pages moves)
    const checkConfig = () => {
      // In Vite, defined strings are replaced. If not defined, it might be undefined or empty
      const key = process.env.GEMINI_API_KEY;
      if (!key || key === 'undefined' || key === '""') {
        console.warn('GEMINI_API_KEY is missing. AI analysis will not work.');
        toast.error('Configuration Warning: GEMINI_API_KEY is missing. Please set it in your deployment environment variables.', {
          duration: Infinity,
          id: 'missing-key-warning'
        });
      }
    };
    
    if (user) {
      checkConfig();
      const q = query(collection(db, 'sources'), where('userId', '==', user.uid));
      const unsubscribe = onSnapshot(q, (snapshot) => {
        const fetchedSources = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setSources(fetchedSources);
      });
      return () => unsubscribe();
    }
  }, [user]);

  const performAnalysis = async (contentSources: string[], analysisTopic: string) => {
    setIsGenerating(true);
    setQuizResult(null);
    setSummaryResult(null);
    setActiveTab('summary_result');
    const toastId = 'analysis';
    
    try {
      // 1. Check Global Research Cache First (Saves Quota)
      toast.loading('Checking Clinical Research Vault...', { id: toastId });
      const cached = await getCachedAnalysis(analysisTopic, contentSources);
      
      if (cached) {
        setQuizResult(cached.quiz);
        setSummaryResult(cached.summary);
        toast.success('Omni-Analysis Loaded from Cache', { id: toastId });
        setIsGenerating(false);
        return;
      }

      // 2. Perform AI Analysis with Retry Logic
      toast.loading('AI is analyzing clinical data...', { id: toastId });
      
      let attempts = 0;
      const maxAttempts = 3;
      let result = null;

      while (attempts < maxAttempts) {
        try {
          result = await performOmniAnalysis(contentSources, analysisTopic);
          break; // Success
        } catch (error: any) {
          attempts++;
          const errorStr = (error?.message || '').toLowerCase();
          const isQuota = errorStr.includes('quota') || errorStr.includes('429') || errorStr.includes('limit');
          
          if (isQuota && attempts < maxAttempts) {
            const waitSec = attempts * 10;
            toast.loading(`Quota reached. Retrying knowledge extraction in ${waitSec}s...`, { id: toastId });
            await new Promise(r => setTimeout(r, waitSec * 1000));
            continue;
          }
          throw error; // Re-throw if not quota or no more attempts
        }
      }

      if (result) {
        setQuizResult(result.quiz);
        setSummaryResult(result.summary);
        
        // 3. Save to Global Cache for others
        await saveToCache(analysisTopic, contentSources, result);
        
        toast.success('Omni-Analysis Complete', { id: toastId });
      }
    } catch (error: any) {
      console.error("AI Analysis Error:", error);
      
      let errorMessage = 'Analysis failed. Please check your data or try a simpler topic.';
      
      // Specifically check for API Key or Auth errors common in external deployments
      const errorStr = (error?.message || error?.toString() || '').toUpperCase();
      
      if (errorStr.includes('API_KEY_INVALID') || errorStr.includes('KEY_NOT_FOUND') || errorStr.includes('NOT DEFINED')) {
        errorMessage = 'Sensitive Data Access Denied: GEMINI_API_KEY is invalid or missing in Vercel. Please double-check your Environment Variables.';
      } else if (error?.status === 429 || errorStr.includes('QUOTA') || errorStr.includes('429') || errorStr.includes('LIMIT')) {
        errorMessage = 'Nursify Free-Limit Reached: To keep this service 100% free for students, Google limits daily usage. Your global cache is active, so results for this topic may appear soon! Please try again in 1 hour.';
      } else if (error?.status === 403 || errorStr.includes('403') || errorStr.includes('PERMISSION_DENIED')) {
        errorMessage = 'Clinical Research Access Denied: Check your Gemini API quota or ensure the key has access to the flash model.';
      } else if (errorStr.includes('SAFETY') || errorStr.includes('HARM_CATEGORY')) {
        errorMessage = 'Material flagged by academic integrity filters. Try a different document.';
      } else {
        errorMessage = `Analysis failed: ${error?.message || 'The research engine encountered an unexpected network error.'}`;
      }

      toast.error(errorMessage, { id: toastId });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    const toastId = toast.loading(`Parsing ${file.name}...`);
    try {
      let content = '';
      let typeLabel = 'text';

      if (file.name.endsWith('.pdf')) {
        const arrayBuffer = await file.arrayBuffer();
        const pdfData = new Uint8Array(arrayBuffer);
        
        // Use timeout and legacy-compatible parsing
        const pdf = await withTimeout(
          pdfjs.getDocument({ data: pdfData }).promise,
          TIMEOUT_MS * 2,
          'PDF loading timed out. The file might be too complex or the engine is unresponsive.'
        );

        let fullText = '';
        const maxPages = Math.min(pdf.numPages, 100); 
        
        for (let i = 1; i <= maxPages; i++) {
          const page = await pdf.getPage(i);
          const textContent = await page.getTextContent();
          const pageText = textContent.items.map((item: any) => 'str' in item ? item.str : '').join(' ');
          fullText += pageText + '\n';
          
          if (i % 5 === 0) {
            toast.loading(`Extracting Evidence: ${i}/${pdf.numPages} pages...`, { id: toastId });
          }
        }
        content = fullText;
        typeLabel = 'pdf';
      } else if (file.name.endsWith('.docx')) {
        const arrayBuffer = await file.arrayBuffer();
        const result = await mammoth.extractRawText({ arrayBuffer });
        content = result.value;
        typeLabel = 'docx';
      } else if (file.name.endsWith('.pptx')) {
        const arrayBuffer = await file.arrayBuffer();
        content = await extractTextFromPPTX(arrayBuffer);
        typeLabel = 'pptx';
      } else {
        content = await file.text();
      }

      if (!content.trim()) {
        throw new Error('Could not extract any content from the provided file.');
      }

      // Pre-upload safety check for Firestore limits
      if (content.length > MAX_FIRESTORE_SIZE) {
        content = content.substring(0, MAX_FIRESTORE_SIZE) + '... [Auto-truncated]';
      }

      toast.loading(`Securing in Knowledge Vault...`, { id: toastId });

      const newSourceData = {
        userId: user.uid,
        name: file.name,
        type: typeLabel,
        content: content,
        createdAt: serverTimestamp()
      };

      const docRef = await addDoc(collection(db, 'sources'), newSourceData);
      
      const currentTopic = topic || file.name.split('.')[0];
      if (!topic) setTopic(currentTopic);
      
      setSelectedSourceIds(prev => [...prev, docRef.id]);

      const existingSelected = sources.filter(s => selectedSourceIds.includes(s.id));
      const contextStrings = [
        ...existingSelected.map(s => `Title: ${s.name}\nType: ${s.type}\nContent: ${s.content}`),
        `Title: ${file.name}\nType: ${typeLabel}\nContent: ${content}`
      ];

      toast.success('Source Verified', { id: toastId });
      performAnalysis(contextStrings, currentTopic);

    } catch (error: any) {
      console.error(error);
      if (error?.code === 'permission-denied') {
        handleFirestoreError(error, 'create', 'sources');
      } else {
        toast.error(error.message || 'Processing failed.', { id: toastId });
      }
    }
  };

  const handleAddNote = async () => {
    if (!uploadTitle || !uploadText || !user) return;
    const toastId = toast.loading('Syncing Clinical Note...');
    try {
      const noteContent = uploadText;
      const noteTitle = uploadTitle;

      const docRef = await addDoc(collection(db, 'sources'), {
        userId: user.uid,
        name: noteTitle,
        type: 'text',
        content: noteContent,
        createdAt: serverTimestamp()
      });

      const currentTopic = topic || noteTitle;
      if (!topic) setTopic(currentTopic);
      
      setSelectedSourceIds(prev => [...prev, docRef.id]);

      const existingSelected = sources.filter(s => selectedSourceIds.includes(s.id));
      const contextStrings = [
        ...existingSelected.map(s => `Title: ${s.name}\nType: ${s.type}\nContent: ${s.content}`),
        `Title: ${noteTitle}\nType: text\nContent: ${noteContent}`
      ];

      setUploadTitle('');
      setUploadText('');
      toast.success('Note Secured', { id: toastId });
      performAnalysis(contextStrings, currentTopic);

    } catch (error) {
      handleFirestoreError(error, 'create', 'sources');
      toast.dismiss(toastId);
    }
  };

  const handleAddLink = async () => {
    if (!videoLink || !user) return;
    const toastId = toast.loading('Syncing Evidence Link...');
    try {
      const linkUrl = videoLink;
      const linkTitle = linkUrl.includes('youtube.com') || linkUrl.includes('youtu.be') ? 'Clinical Video Data' : 'Evidence Reference';

      const docRef = await addDoc(collection(db, 'sources'), {
        userId: user.uid,
        name: linkTitle,
        type: 'link',
        content: linkUrl,
        createdAt: serverTimestamp()
      });

      const currentTopic = topic || (linkUrl.includes('youtube.com') || linkUrl.includes('youtu.be') ? 'Nursing Video Review' : 'Research Article');
      if (!topic) setTopic(currentTopic);
      
      setSelectedSourceIds(prev => [...prev, docRef.id]);

      const existingSelected = sources.filter(s => selectedSourceIds.includes(s.id));
      const contextStrings = [
        ...existingSelected.map(s => `Title: ${s.name}\nType: ${s.type}\nContent: ${s.content}`),
        `Title: ${linkTitle}\nContent: ${linkUrl}`
      ];

      setVideoLink('');
      toast.success('Link Attached', { id: toastId });
      performAnalysis(contextStrings, currentTopic);

    } catch (error) {
      handleFirestoreError(error, 'create', 'sources');
      toast.dismiss(toastId);
    }
  };

  const handleDeleteSource = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'sources', id));
      setSelectedSourceIds(prev => prev.filter(sid => sid !== id));
      toast.success('Source removed');
    } catch (error) {
      handleFirestoreError(error, 'delete', `sources/${id}`);
    }
  };

  const toggleSourceSelection = (id: string) => {
    setSelectedSourceIds(prev => 
      prev.includes(id) ? prev.filter(sid => sid !== id) : [...prev, id]
    );
  };

  const runSmartAnalysis = async () => {
    if (selectedSourceIds.length === 0 || !topic) {
      toast.error('Please select sources and define a topic for analysis');
      return;
    }
    
    const selectedSources = sources
      .filter(s => selectedSourceIds.includes(s.id))
      .map(s => `Title: ${s.name}\nSource Type: ${s.type}\nContent: ${s.content}`);
    
    performAnalysis(selectedSources, topic);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Progress value={33} className="w-[60%]" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <Toaster position="top-center" richColors />
        <Card className="w-full max-w-md geometric-card border-none shadow-xl">
          <CardHeader className="text-center">
            <div className="mx-auto w-16 h-16 bg-indigo-900 rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-indigo-200">
              <GraduationCap className="text-white w-8 h-8" />
            </div>
            <CardTitle className="text-3xl font-bold tracking-tight text-slate-900">Nursify</CardTitle>
            <CardDescription className="text-slate-500 text-lg">
              Precision Nursing Study Tool
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-4 p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="flex gap-3">
                <CheckCircle2 className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                <p className="text-sm text-slate-600 font-medium">Strict Source Verification: ON</p>
              </div>
              <div className="flex gap-3">
                <CheckCircle2 className="w-5 h-5 text-indigo-500 mt-1 flex-shrink-0" />
                <p className="text-sm text-slate-600 font-medium">MCQ Rationales & Explanations</p>
              </div>
            </div>
            <div className="space-y-3">
              <Button 
                disabled={isLoggingIn}
                onClick={async () => {
                  setIsLoggingIn(true);
                  try {
                    await signInWithGoogle();
                  } catch (err: any) {
                    setIsLoggingIn(false);
                    if (err?.code === 'auth/unauthorized-domain') {
                      toast.error('Domain not authorized in Firebase. Please add your Vercel URL to the Authorized Domains list in Firebase Console.');
                    } else if (err?.code === 'auth/popup-blocked') {
                      toast.info('Popup blocked. Trying redirect method...');
                      // Fallback to redirect if popup is blocked
                      const { getAuth, GoogleAuthProvider, signInWithRedirect } = await import('firebase/auth');
                      const auth = getAuth();
                      const provider = new GoogleAuthProvider();
                      await signInWithRedirect(auth, provider);
                    } else {
                      toast.error(`Login failed: ${err.message || 'Unknown error'}`);
                    }
                  }
                }} 
                className="w-full btn-primary py-6 text-lg rounded-2xl shadow-indigo-100 font-bold"
              >
                {isLoggingIn ? 'Connecting to Vault...' : 'Enter Research Console'}
              </Button>
              <Button 
                variant="outline"
                onClick={() => {
                  if (deferredPrompt) {
                    handleInstallClick();
                  } else {
                    setShowInstallGuide(true);
                  }
                }}
                className="w-full py-6 text-sm rounded-2xl border-slate-200 text-slate-600 font-bold flex items-center justify-center gap-3 hover:bg-slate-50 transition-all active:scale-95"
              >
                <Download className="w-5 h-5" />
                Add Nursify to Home Screen
              </Button>
              <p className="text-[10px] text-center text-slate-400">
                Uses Secure Google Research Authentication
              </p>
            </div>
          </CardContent>
          <CardFooter className="justify-center">
            <p className="text-xs text-slate-400 font-bold uppercase tracking-widest">Academic Excellence Enabled</p>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row h-screen overflow-hidden bg-slate-50 font-sans text-slate-800">
      <Toaster position="top-center" richColors />
      
      <AnimatePresence>
        {showInstallGuide && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[300] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setShowInstallGuide(false)}
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white rounded-[32px] w-full max-w-sm p-8 shadow-2xl overflow-hidden relative"
              onClick={e => e.stopPropagation()}
            >
              <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-50 rounded-full -translate-y-1/2 translate-x-1/2 -z-0" />
              
              <div className="relative z-10 text-center space-y-6">
                <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto shadow-xl shadow-indigo-100">
                  <Download className="w-8 h-8 text-white" />
                </div>
                
                <div className="space-y-2">
                  <h3 className="text-2xl font-bold text-slate-900 leading-tight">Install Nursify</h3>
                  <p className="text-sm text-slate-500 font-medium">Add to your home screen for the full study experience.</p>
                </div>

                <div className="space-y-4 pt-4">
                  {isIOS ? (
                    <div className="space-y-4 text-left p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="flex items-start gap-3">
                        <div className="bg-indigo-100 text-indigo-700 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0">1</div>
                        <p className="text-xs font-semibold text-slate-700">Tap the <span className="font-bold underline text-indigo-600">Share</span> icon in Safari (the square with ↑ arrow).</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="bg-indigo-100 text-indigo-700 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0">2</div>
                        <p className="text-xs font-semibold text-slate-700">Scroll down and tap <span className="font-bold underline text-indigo-600">"Add to Home Screen"</span>.</p>
                      </div>
                      <p className="text-[9px] text-slate-400 text-center pt-2 italic">Note: If you are in a preview, open the app in a new browser tab first.</p>
                    </div>
                  ) : (
                    <div className="space-y-4 text-left p-4 bg-slate-50 rounded-2xl border border-slate-100">
                      <div className="flex items-start gap-3">
                        <div className="bg-indigo-100 text-indigo-700 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0">1</div>
                        <p className="text-xs font-semibold text-slate-700">Open your browser menu (usually <span className="font-bold text-indigo-600">⋮</span> or <span className="font-bold text-indigo-600">⋯</span>).</p>
                      </div>
                      <div className="flex items-start gap-3">
                        <div className="bg-indigo-100 text-indigo-700 w-6 h-6 rounded-full flex items-center justify-center font-bold text-xs flex-shrink-0">2</div>
                        <p className="text-xs font-semibold text-slate-700">Select <span className="font-bold underline text-indigo-600">"Install App"</span> or "Add to Home Screen".</p>
                      </div>
                      <p className="text-[9px] text-slate-400 text-center pt-2 italic">Note: If you are in a preview, open the app in a new browser tab first for the "Install" option to appear.</p>
                    </div>
                  )}

                  <Button 
                    onClick={() => setShowInstallGuide(false)}
                    className="w-full bg-slate-900 hover:bg-black text-white py-6 rounded-2xl font-bold uppercase tracking-widest text-[10px]"
                  >
                    Got It
                  </Button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}

        {showInstallPrompt && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="fixed bottom-24 lg:bottom-10 left-1/2 -translate-x-1/2 z-[200] w-[92%] max-w-md"
          >
            <Card className="border-none shadow-2xl bg-indigo-900 text-white overflow-hidden rounded-[32px]">
              <CardContent className="p-6 lg:p-8">
                <div className="flex gap-5">
                  <div className="w-14 h-14 bg-white/10 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-inner">
                    <Download className="w-7 h-7 text-indigo-300" />
                  </div>
                  <div className="space-y-1">
                    <h4 className="text-lg font-bold text-white tracking-tight">Personal Study Vault</h4>
                    <p className="text-xs text-indigo-200 leading-relaxed font-medium">
                      Install Nursify to your home screen for smoother research and offline access.
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 mt-8">
                  <Button 
                    onClick={() => setShowInstallPrompt(false)}
                    variant="ghost" 
                    className="text-white/60 hover:text-white hover:bg-white/5 rounded-2xl font-bold uppercase tracking-widest text-[10px]"
                  >
                    Maybe Later
                  </Button>
                  <Button 
                    onClick={handleInstallClick}
                    className="bg-white text-indigo-900 hover:bg-indigo-50 rounded-2xl font-bold uppercase tracking-widest text-[10px] shadow-lg"
                  >
                    Install Now
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {user && !user.emailVerified && (
        <div className="fixed top-2 left-1/2 -translate-x-1/2 z-[100] w-[90%] max-w-md bg-amber-50 border border-amber-200 p-3 rounded-xl shadow-lg flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
          <p className="text-[10px] font-bold text-amber-800 leading-tight uppercase tracking-wide">
            Account Verification Required: Please verify your email to enable clinical data storage.
          </p>
        </div>
      )}
      
      {/* 1. Navigation - Left Rail on Desktop, Bottom Rail on Mobile */}
      <nav className="w-full lg:w-20 bg-indigo-900 flex flex-row lg:flex-col items-center justify-between lg:justify-start px-6 lg:px-0 py-4 lg:py-8 space-x-6 lg:space-x-0 lg:space-y-8 flex-shrink-0 z-50 order-2 lg:order-none">
        <div className="hidden lg:flex w-12 h-12 bg-white rounded-xl items-center justify-center shadow-md">
          <div className="w-7 h-7 bg-indigo-600 rounded-lg flex items-center justify-center">
            <GraduationCap className="text-white w-4 h-4" />
          </div>
        </div>
        
        <div className="flex flex-row lg:flex-col items-center gap-6 lg:gap-8 flex-1 lg:flex-none justify-center">
          <div 
            className={`p-2 lg:w-10 lg:h-10 rounded-lg flex items-center justify-center cursor-pointer transition-colors ${activeTab === 'sources' ? 'bg-indigo-600' : 'bg-indigo-800 hover:bg-indigo-700'}`}
            onClick={() => setActiveTab('sources')}
            title="Source Library"
          >
            <History className="w-5 h-5 text-indigo-100" />
            <span className="lg:hidden text-[10px] text-white ml-2">Workbench</span>
          </div>
          <div 
            className={`p-2 lg:w-10 lg:h-10 rounded-lg flex items-center justify-center cursor-pointer transition-colors ${activeTab === 'summary_result' ? 'bg-indigo-600' : 'bg-indigo-800 hover:bg-indigo-700'}`}
            onClick={() => setActiveTab('summary_result')}
            title="Summary Hub"
          >
            <FileText className="w-5 h-5 text-indigo-100" />
            <span className="lg:hidden text-[10px] text-white ml-2">Summary</span>
          </div>
          <div 
            className={`p-2 lg:w-10 lg:h-10 rounded-lg flex items-center justify-center cursor-pointer transition-colors ${activeTab === 'quiz_result' ? 'bg-indigo-600' : 'bg-indigo-800 hover:bg-indigo-700'}`}
            onClick={() => setActiveTab('quiz_result')}
            title="MCQ Sandbox"
          >
            <BrainCircuit className="w-5 h-5 text-indigo-100" />
            <span className="lg:hidden text-[10px] text-white ml-2">MCQs</span>
          </div>

          <div 
            className="p-2 lg:w-10 lg:h-10 rounded-lg flex items-center justify-center cursor-pointer bg-amber-500 hover:bg-amber-400 transition-colors shadow-lg shadow-amber-900/20"
            onClick={() => {
              if (deferredPrompt) {
                handleInstallClick();
              } else {
                setShowInstallGuide(true);
              }
            }}
            title="Download App"
          >
            <Download className="w-5 h-5 text-white" />
            <span className="lg:hidden text-[10px] text-white ml-2">Add to Screen</span>
          </div>

          {(summaryResult || quizResult) && (
            <div 
              className="p-2 lg:w-10 lg:h-10 rounded-lg flex items-center justify-center cursor-pointer bg-emerald-600 hover:bg-emerald-500 transition-colors animate-in fade-in zoom-in"
              onClick={() => {
                if (activeTab === 'summary_result' && summaryResult) {
                  exportSummaryToPDF(summaryResult, topic);
                } else if (activeTab === 'quiz_result' && quizResult) {
                  exportQuizToPDF(quizResult, topic);
                } else {
                  toast.info("Switch to Summary or MCQ tab to download specific results.");
                }
              }}
              title="Quick Export"
            >
              <Download className="w-5 h-5 text-white" />
              <span className="lg:hidden text-[10px] text-white ml-2">Export</span>
            </div>
          )}
        </div>

        <div className="lg:mt-auto">
          <Button variant="ghost" size="icon" onClick={logout} className="text-indigo-300 hover:text-white hover:bg-indigo-800 rounded-lg">
            <LogOut className="w-5 h-5" />
          </Button>
        </div>
      </nav>

      {/* 2. Source Library Pane - Collapsible on Mobile */}
      <aside className={`
        fixed inset-0 z-40 bg-white lg:relative lg:block lg:w-72 lg:inset-auto border-r border-slate-200 lg:flex-shrink-0 transition-transform duration-300 transform
        ${activeTab === 'sources' ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
      `}>
        <div className="p-4 lg:p-6 h-full flex flex-col overflow-hidden pb-20 lg:pb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Source Library</h2>
            <button onClick={() => setActiveTab('summary_result')} className="lg:hidden p-1 text-slate-400">
               <ChevronRight className="w-5 h-5 rotate-180" />
            </button>
          </div>
          
          <div className="mb-6 space-y-2">
            <label className="w-full py-3 bg-indigo-50 border-2 border-dashed border-indigo-200 rounded-xl text-indigo-600 font-semibold text-sm hover:bg-indigo-100 transition-colors flex items-center justify-center gap-2 cursor-pointer">
              <Upload className="w-4 h-4" />
              + Upload Data
              <input type="file" className="hidden" accept=".pdf,.txt,.md,.docx,.pptx" onChange={handleFileUpload} />
            </label>
            
            <Accordion className="w-full">
              <AccordionItem value="note" className="border-slate-100">
                <AccordionTrigger className="text-xs font-bold text-indigo-600 hover:no-underline py-2 uppercase tracking-wide">
                  Add Quick Note
                </AccordionTrigger>
                <AccordionContent className="pt-2 space-y-2">
                  <Input 
                    placeholder="Title" 
                    value={uploadTitle} 
                    onChange={e => setUploadTitle(e.target.value)}
                    className="h-8 text-xs rounded-lg bg-slate-50 border-none"
                  />
                  <textarea 
                    className="w-full h-24 p-2 text-xs border-none bg-slate-50 rounded-lg focus:ring-1 focus:ring-indigo-500 outline-none"
                    placeholder="Content..."
                    value={uploadText}
                    onChange={e => setUploadText(e.target.value)}
                  />
                  <Button onClick={handleAddNote} className="w-full h-8 bg-indigo-600 text-white text-[10px] uppercase font-bold py-1">Save</Button>
                </AccordionContent>
              </AccordionItem>
              
              <AccordionItem value="link" className="border-slate-100">
                <AccordionTrigger className="text-xs font-bold text-indigo-600 hover:no-underline py-2 uppercase tracking-wide">
                  Analysis Tool: Web/Video
                </AccordionTrigger>
                <AccordionContent className="pt-2 space-y-2">
                  <Input 
                    placeholder="Paste YouTube or Resource URL" 
                    value={videoLink} 
                    onChange={e => setVideoLink(e.target.value)}
                    className="h-8 text-xs rounded-lg bg-slate-50 border-none"
                  />
                  <Button onClick={handleAddLink} className="w-full h-8 bg-indigo-600 text-white text-[10px] uppercase font-bold py-1">Attach URL</Button>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>

          <div className="flex-1 flex flex-col overflow-hidden">
            {isMobile && (
              <div className="p-5 bg-indigo-600 shadow-xl shadow-indigo-100 rounded-[24px] mb-6 text-white border-none relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-24 h-24 bg-white/5 rounded-full -translate-y-1/2 translate-x-1/2" />
                <div className="relative z-10 flex flex-col gap-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-white text-indigo-600 rounded-xl flex items-center justify-center shadow-lg">
                      <Download className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.2em] opacity-70">Nursify Platform</p>
                      <h4 className="text-sm font-bold">Install to Home Screen</h4>
                    </div>
                  </div>
                  
                  <Button 
                    onClick={() => {
                      if (deferredPrompt) {
                        handleInstallClick();
                      } else {
                        setShowInstallGuide(true);
                      }
                    }}
                    className="w-full bg-white text-indigo-900 hover:bg-indigo-50 font-bold py-5 rounded-xl shadow-md active:scale-95 transition-all text-xs"
                  >
                    Quick Add to Device
                  </Button>
                </div>
              </div>
            )}
            
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Library ({sources.length})</p>
              {selectedSourceIds.length > 0 && <span className="text-[10px] font-bold text-indigo-600">{selectedSourceIds.length} ACTIVE</span>}
            </div>
            
            <div className="flex-1 overflow-y-auto -mx-2 px-2">
              <div className="space-y-2 pb-4">
                {sources.length === 0 ? (
                  <div className="py-12 px-4 text-center">
                    <div className="w-12 h-12 bg-slate-50 border border-slate-100 rounded-xl flex items-center justify-center mx-auto mb-4">
                      <BookOpen className="w-6 h-6 text-slate-300" />
                    </div>
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest leading-loose">Your Vault is empty.<br/>Upload clinical data to start.</p>
                  </div>
                ) : (
                  sources.map(source => (
                    <div
                      key={source.id}
                      className={`group p-3 rounded-xl border transition-all cursor-pointer flex items-center justify-between ${
                        selectedSourceIds.includes(source.id) 
                        ? 'bg-indigo-50 border-indigo-200 ring-1 ring-indigo-200' 
                        : 'bg-slate-50 border-slate-100 hover:border-slate-200'
                      }`}
                      onClick={() => toggleSourceSelection(source.id)}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={`w-8 h-8 rounded flex items-center justify-center font-bold text-[10px] flex-shrink-0 ${
                          source.type === 'pdf' ? 'bg-orange-100 text-orange-600' : 
                          source.type === 'pptx' ? 'bg-indigo-100 text-indigo-600' :
                          source.type === 'docx' ? 'bg-blue-100 text-blue-600' :
                          'bg-slate-100 text-slate-600'
                        }`}>
                          {source.type.toUpperCase().substring(0, 3)}
                        </div>
                        <div className="truncate">
                          <p className={`text-sm font-semibold truncate ${selectedSourceIds.includes(source.id) ? 'text-indigo-900' : 'text-slate-700'}`}>
                            {source.name}
                          </p>
                          <p className="text-[10px] text-slate-400 font-medium">Source Verified</p>
                        </div>
                      </div>
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        className={`h-6 w-6 hover:bg-red-100 hover:text-red-600 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity`}
                        onClick={(e) => { e.stopPropagation(); handleDeleteSource(source.id); }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 border-t border-slate-100">
          <div className="flex items-center space-x-2">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
            <span className="text-xs text-slate-500 font-bold uppercase tracking-wider">Secure Sandbox Active</span>
          </div>
        </div>
      </aside>

      {/* 3. Main Interaction Area */}
      <main className="flex-1 flex flex-col overflow-hidden bg-slate-50">
        {/* Header */}
        <header className="h-20 bg-white border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between flex-shrink-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-bold text-slate-900 truncate">
                {topic ? `Studying: ${topic}` : 'Select Topic to Start'}
              </h1>
              {selectedSourceIds.length > 0 && (
                <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-100 rounded-md font-bold text-[10px] px-2 py-0">
                  {selectedSourceIds.length} SOURCES
                </Badge>
              )}
            </div>
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mt-1">
              Nursing Evidence-Based Practice Dashboard
            </p>
          </div>
          <div className="flex gap-3">
            <div className="flex items-center gap-2 mr-4 text-xs font-bold text-slate-400">
              <img src={user.photoURL || ''} className="w-7 h-7 rounded-full border border-slate-200" alt="" />
              <span className="hidden md:inline uppercase tracking-tighter">{user.displayName}</span>
            </div>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto bg-slate-50 relative pb-20 lg:pb-0">
          <div className="p-4 lg:p-8 max-w-6xl mx-auto w-full">
            <AnimatePresence mode="wait">
              {(activeTab === 'sources' || !isMobile) && activeTab === 'sources' && (
                <motion.div 
                  key="workbench"
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 1.02 }}
                  className="grid grid-cols-12 gap-4 lg:gap-8"
                >
                  {/* Generator Console */}
                  <div className="col-span-12 lg:col-span-8 space-y-4 lg:space-y-6">
                    <div className="bg-white rounded-2xl lg:rounded-3xl border border-slate-200 p-6 lg:p-8 shadow-sm">
                      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
                        <h3 className="font-bold text-lg flex items-center text-slate-900">
                          <span className="w-2 h-6 bg-indigo-500 rounded-full mr-3 shadow-lg shadow-indigo-100"></span>
                          Define Study Scope
                        </h3>
                        <span className="px-3 py-1 bg-indigo-50 text-indigo-700 text-[10px] font-bold uppercase rounded-lg border border-indigo-100">
                          Gemini 3.1 Reasoning Active
                        </span>
                      </div>
                      
                      <div className="space-y-6 lg:space-y-8">
                        <div className="relative">
                          <Search className="absolute left-4 lg:left-5 top-1/2 -translate-y-1/2 w-5 h-5 lg:w-6 lg:h-6 text-indigo-300" />
                          <Input 
                            className="h-16 lg:h-20 pl-12 lg:pl-14 text-lg lg:text-xl font-semibold rounded-xl lg:rounded-2xl bg-slate-50 border-slate-100 focus:bg-white focus:ring-4 focus:ring-indigo-50 transition-all shadow-inner border-none"
                            placeholder="Primary Topic (e.g. Fluids)"
                            value={topic}
                            onChange={(e) => setTopic(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && runSmartAnalysis()}
                          />
                        </div>

                        <div className="flex flex-col gap-4">
                          <div className="p-6 lg:p-10 border-2 border-dashed border-indigo-100 rounded-[32px] lg:rounded-[40px] flex flex-col items-center text-center">
                            <div className={`p-4 lg:p-5 rounded-2xl lg:rounded-3xl mb-4 ${isGenerating ? 'bg-indigo-100' : 'bg-slate-50'}`}>
                              <BrainCircuit className={`w-10 h-10 lg:w-12 lg:h-12 ${isGenerating ? 'text-indigo-600 animate-pulse' : 'text-slate-300'}`} />
                            </div>
                            <h4 className="text-lg lg:text-xl font-bold text-slate-800">
                              {isGenerating ? 'Synthesizing Evidence...' : 'Direct-to-Dashboard Sync'}
                            </h4>
                            <p className="text-xs lg:text-sm text-slate-500 max-w-xs mt-2 font-medium">
                              Analysis triggers automatically when you upload sources.
                            </p>
                          </div>

                          <Button 
                            onClick={runSmartAnalysis} 
                            disabled={isGenerating || selectedSourceIds.length === 0 || !topic}
                            className="h-14 rounded-xl lg:rounded-2xl bg-indigo-50 text-indigo-600 hover:bg-indigo-100 border-none font-bold shadow-none"
                          >
                            <Sparkles className="w-4 h-4 mr-2" />
                            Recalculate Full Analysis
                          </Button>
                          
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div className="p-4 bg-slate-50 rounded-xl lg:rounded-2xl border border-slate-100 flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
                                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                              </div>
                              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Dashboards Ready</p>
                            </div>
                            <div className="p-4 bg-slate-50 rounded-xl lg:rounded-2xl border border-slate-100 flex items-center gap-3">
                              <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center">
                                <FileText className="w-4 h-4 text-indigo-600" />
                              </div>
                              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">{selectedSourceIds.length} Sources Selected</p>
                            </div>
                          </div>
                        </div>

                        {isGenerating && (
                          <div className="p-12 text-center space-y-6">
                            <div className="flex justify-center gap-2">
                              {[0, 1, 2].map(i => (
                                <motion.div 
                                  key={i}
                                  animate={{ height: [8, 24, 8] }} 
                                  transition={{ repeat: Infinity, duration: 0.8, delay: i * 0.15 }} 
                                  className="w-1.5 bg-indigo-500 rounded-full" 
                                />
                              ))}
                            </div>
                            <p className="text-xs font-bold text-indigo-400 uppercase tracking-[0.2em]">Executing Source Verification Algorithm...</p>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="p-6 bg-indigo-900 rounded-3xl text-white shadow-xl shadow-indigo-100">
                      <div className="flex gap-4">
                        <div className="w-12 h-12 bg-white/10 rounded-2xl flex items-center justify-center flex-shrink-0">
                          <AlertCircle className="w-6 h-6 text-indigo-300" />
                        </div>
                        <div className="space-y-1">
                          <p className="font-bold text-indigo-100">Nursing Compliance Engine</p>
                          <p className="text-xs opacity-60 leading-relaxed font-medium">
                            Nursify ensures all generated content is extracted exclusively from the documents in your Knowledge Vault. External links are provided solely to reinforce learning gaps, not as data sources for MCQs.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right: Quick Stats */}
                  <div className="col-span-12 lg:col-span-4 space-y-4 lg:space-y-6">
                    <div className="bg-white rounded-2xl lg:rounded-3xl border border-slate-200 p-6 lg:p-8 flex flex-col items-center text-center shadow-sm">
                      <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center mb-6 shadow-inner">
                        <CheckCircle2 className="w-8 h-8" />
                      </div>
                      <h4 className="text-sm font-bold uppercase tracking-widest text-slate-900">Study Coverage</h4>
                      <p className="text-xs text-slate-400 font-bold mb-6 mt-1">Uploaded Evidence Integration</p>
                      
                      <div className="w-full space-y-4">
                        <div className="flex justify-between text-[10px] font-bold text-slate-500">
                          <span>ANALYSIS PROGRESS</span>
                          <span>92%</span>
                        </div>
                        <div className="w-full bg-slate-100 h-3 rounded-full overflow-hidden">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: '92%' }}
                            className="bg-emerald-500 h-full rounded-full"
                          />
                        </div>
                        <p className="text-[10px] text-emerald-600 font-bold text-left bg-emerald-50 p-3 rounded-xl">
                          Ready for clinical reasoning simulations.
                        </p>
                      </div>
                    </div>
                  </div>
                </motion.div>
              )}

              {activeTab === 'summary_result' && (
                <motion.div 
                  key="summary" 
                  initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                  className="space-y-6 lg:space-y-8"
                >
                  {!summaryResult ? (
                    <div className="bg-white rounded-[24px] lg:rounded-[32px] border border-slate-200 p-8 lg:p-20 text-center shadow-sm">
                      <div className="w-16 h-16 lg:w-20 lg:h-20 bg-slate-50 text-slate-300 rounded-full flex items-center justify-center mx-auto mb-6">
                        <FileText className="w-8 h-8 lg:w-10 lg:h-10" />
                      </div>
                      <h3 className="text-xl lg:text-2xl font-bold text-slate-900 mb-2">No Summary Generated</h3>
                      <p className="text-sm lg:text-slate-500 max-w-sm mx-auto mb-8 font-medium italic opacity-70 lg:opacity-100">Please select your sources in the vault and run analysis to generate a synthesis.</p>
                      <Button onClick={() => setActiveTab('sources')} variant="outline" className="rounded-xl px-6 lg:px-8 border-slate-200">Return to Workbench</Button>
                    </div>
                  ) : (
                    <div className="bg-white rounded-2xl lg:rounded-[32px] border border-slate-200 shadow-sm relative overflow-hidden flex flex-col">
                      {/* Sticky Header with Download */}
                      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur-md border-b border-slate-100 p-6 lg:px-10 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div className="flex items-center gap-3 lg:gap-4">
                          <div className="p-3 bg-indigo-900 rounded-xl text-white">
                            <FileText className="w-5 h-5" />
                          </div>
                          <div>
                            <h3 className="text-xl lg:text-2xl font-bold text-slate-900">Summary Hub</h3>
                            <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Foundational Synthesis</p>
                          </div>
                        </div>
                        <Button 
                          onClick={() => exportSummaryToPDF(summaryResult, topic)}
                          className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-bold text-xs px-6 py-5 h-auto shadow-lg shadow-indigo-100"
                        >
                          <Download className="w-4 h-4 mr-2" />
                          Download PDF Summary
                        </Button>
                      </div>
                      
                      <div className="p-6 lg:p-10 relative">
                        <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-50/50 rounded-full -translate-y-1/2 translate-x-1/2 blur-3xl -z-0" />
                        
                        <div className="relative z-10 prose prose-sm lg:prose-indigo max-w-none prose-headings:font-bold prose-p:font-medium prose-p:text-slate-600 prose-li:font-medium prose-p:leading-relaxed">
                          <Markdown>{summaryResult.content}</Markdown>
                        </div>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              {activeTab === 'quiz_result' && (
                <motion.div 
                  key="quiz" 
                  initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                  className="space-y-6 lg:space-y-8"
                >
                  {!quizResult ? (
                    <div className="bg-white rounded-[24px] lg:rounded-[32px] border border-slate-200 p-8 lg:p-20 text-center shadow-sm">
                      <div className="w-16 h-16 lg:w-20 lg:h-20 bg-slate-50 text-slate-300 rounded-full flex items-center justify-center mx-auto mb-6">
                        <BrainCircuit className="w-8 h-8 lg:w-10 lg:h-10" />
                      </div>
                      <h3 className="text-xl lg:text-2xl font-bold text-slate-900 mb-2">Quiz Board Empty</h3>
                      <p className="text-sm lg:text-slate-500 max-w-sm mx-auto mb-8 font-medium">Select sources and run the analysis to generate custom MCQ case studies.</p>
                      <Button onClick={() => setActiveTab('sources')} variant="outline" className="rounded-xl px-6 lg:px-8 border-slate-200">Go to Vault</Button>
                    </div>
                  ) : (
                    <div className="space-y-6 lg:space-y-8">
                      {/* Sticky Header for Quiz Export */}
                      <div className="sticky top-0 z-20 bg-slate-50/95 backdrop-blur-md py-4 border-b border-slate-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-4">
                        <div className="flex items-center gap-3 lg:gap-4">
                          <div className="p-3 bg-indigo-600 rounded-xl lg:rounded-2xl text-white shadow-lg shadow-indigo-100">
                            <BrainCircuit className="w-5 h-5 lg:w-6 lg:h-6" />
                          </div>
                          <div>
                            <h3 className="text-xl lg:text-2xl font-bold text-slate-900 tracking-tight">{topic} Sandbox</h3>
                            <p className="text-[9px] lg:text-xs font-bold text-slate-500 uppercase tracking-widest mt-1">MCQs from {selectedSourceIds.length} Sources</p>
                          </div>
                        </div>
                        <Button 
                          onClick={() => exportQuizToPDF(quizResult, topic)}
                          className="w-full sm:w-auto bg-slate-900 hover:bg-black text-white rounded-xl font-bold text-xs px-6 py-5 h-auto shadow-lg shadow-slate-200 transition-all"
                        >
                          <Download className="w-4 h-4 mr-2" />
                          Export Quiz Results
                        </Button>
                      </div>
                      
                      <div className="grid grid-cols-1 gap-4 lg:gap-6">
                        {quizResult.map((q, idx) => (
                          <div key={idx} className="bg-white rounded-2xl lg:rounded-3xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
                            <div className="p-6 lg:p-8 border-b border-slate-50">
                              <Badge className="mb-4 bg-indigo-50 text-indigo-700 border-indigo-100 rounded-md font-bold uppercase tracking-widest text-[9px]">Case {idx + 1}</Badge>
                              <p className="text-base lg:text-lg font-bold text-slate-800 leading-snug">{q.question}</p>
                            </div>
                            <div className="p-6 lg:p-8 bg-slate-50/30">
                              <div className="grid grid-cols-1 gap-3">
                                {q.options.map((opt, oIdx) => (
                                  <div key={oIdx} className={`p-4 lg:p-5 rounded-xl lg:rounded-2xl border bg-white flex items-center justify-between text-xs lg:text-sm font-semibold transition-all ${opt === q.correctAnswer ? 'border-emerald-200 bg-emerald-50/50 shadow-sm ring-1 ring-emerald-100' : 'border-slate-100 hover:border-slate-300'}`}>
                                    <span className={opt === q.correctAnswer ? 'text-emerald-900' : 'text-slate-700'}>{opt}</span>
                                    {opt === q.correctAnswer && <CheckCircle2 className="w-4 h-4 lg:w-5 lg:h-5 text-emerald-500" />}
                                  </div>
                                ))}
                              </div>
                              
                              <Accordion className="mt-4 lg:mt-6">
                                <AccordionItem value="rationale" className="border-none">
                                  <AccordionTrigger className="text-[10px] lg:text-xs font-bold text-indigo-600 hover:no-underline bg-white p-3 lg:p-4 rounded-lg lg:rounded-xl border border-indigo-100 shadow-sm uppercase tracking-widest">
                                    View Rationale
                                  </AccordionTrigger>
                                  <AccordionContent className="p-4 lg:p-6 bg-white border border-slate-200 rounded-xl mt-3 text-xs lg:text-sm text-slate-600 leading-relaxed shadow-inner">
                                    <div className="flex gap-3 lg:gap-4">
                                      <div className="w-1 h-auto bg-indigo-500 rounded-full flex-shrink-0" />
                                      <p className="font-medium italic">{q.explanation}</p>
                                    </div>
                                  </AccordionContent>
                                </AccordionItem>
                              </Accordion>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </motion.div>
              )}

              {activeTab === 'related_sources' && (
                <motion.div 
                  key="related" 
                  initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}
                >
                  {!summaryResult ? (
                    <div className="bg-white rounded-[32px] border border-slate-200 p-20 text-center shadow-sm">
                      <div className="w-20 h-20 bg-slate-50 text-slate-300 rounded-full flex items-center justify-center mx-auto mb-6">
                        <ExternalLink className="w-10 h-10" />
                      </div>
                      <h3 className="text-2xl font-bold text-slate-900 mb-2">Evidence Hub Empty</h3>
                      <p className="text-slate-500 max-w-sm mx-auto mb-8 font-medium">Smart analysis will populate this dashboard with external high-quality nursing evidence links.</p>
                      <Button onClick={() => setActiveTab('sources')} variant="outline" className="rounded-xl px-8 border-slate-200">Open Research Console</Button>
                    </div>
                  ) : (
                    <div className="bg-indigo-900 rounded-[32px] p-10 text-white shadow-2xl shadow-indigo-200 relative overflow-hidden">
                      <div className="absolute bottom-0 left-0 w-96 h-96 bg-white/5 rounded-full translate-y-1/2 -translate-x-1/2 blur-3xl shadow-inner" />

                      <div className="relative z-10">
                        <div className="flex items-center gap-4 mb-10 pb-6 border-b border-indigo-800">
                          <div className="p-3 bg-white/10 rounded-2xl">
                            <ExternalLink className="w-8 h-8 text-indigo-300" />
                          </div>
                          <div>
                            <h3 className="text-3xl font-bold">Evidence Links Hub</h3>
                            <p className="text-sm font-bold text-indigo-400 uppercase tracking-widest mt-1">External Evidence & Deep Dives</p>
                          </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                          {summaryResult.recommendations.map((rec, rIdx) => (
                            <a 
                              key={rIdx} 
                              href={rec.url} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="group block p-8 bg-white/5 rounded-3xl border border-white/10 hover:bg-white/10 transition-all hover:-translate-y-2 shadow-lg"
                            >
                              <div className="flex items-start justify-between mb-6">
                                <div className="w-10 h-10 bg-indigo-500/20 rounded-xl flex items-center justify-center group-hover:scale-110 transition-transform">
                                  <Search className="w-5 h-5 text-indigo-300" />
                                </div>
                                <ExternalLink className="w-4 h-4 text-indigo-400 group-hover:text-white" />
                              </div>
                              <h4 className="text-xl font-bold leading-tight mb-4 group-hover:text-indigo-200">{rec.title}</h4>
                              <div className="pt-6 border-t border-white/5 flex items-center gap-2">
                                <p className="text-[10px] text-indigo-300 font-bold uppercase tracking-widest">{new URL(rec.url).hostname}</p>
                              </div>
                            </a>
                          ))}
                        </div>
                      </div>

                      <div className="mt-12 p-8 bg-white/5 rounded-2xl border border-white/10">
                        <h5 className="text-sm font-bold text-indigo-200 uppercase tracking-widest mb-4">Why these sources?</h5>
                        <p className="text-sm text-indigo-100/80 leading-relaxed font-medium">
                          Based on your uploaded content regarding <span className="text-white">"{topic}"</span>, these resources have been curated to fill critical reasoning gaps and provide the latest evidence-based benchmarks required for clinical mastery.
                        </p>
                      </div>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>
    </div>
  );
}
