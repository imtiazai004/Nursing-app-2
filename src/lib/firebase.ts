import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer, initializeFirestore } from 'firebase/firestore';
import { toast } from 'sonner';
import firebaseConfig from '@/firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// For maximum reliability, we use getFirestore with the specific database ID.
// Long polling is only enabled if the environment explicitly requires it or for stability.
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

const googleProvider = new GoogleAuthProvider();

export const signInWithGoogle = async () => {
  try {
    return await signInWithPopup(auth, googleProvider);
  } catch (error: any) {
    console.error("Login Error:", error);
    throw error;
  }
};
export const logout = () => signOut(auth);

async function testConnection() {
  try {
    // Try to reach the server directly to verify config and networking
    await getDocFromServer(doc(db, 'test', 'connection'));
    console.log("Firebase connection test successful.");
  } catch (error: any) {
    console.error("Firebase Connection Result:", error.code, error.message);
    if (error.code === 'unavailable') {
      // If standard connection fails, we might want to suggest checking if the DB is provisioned
      console.warn("Firestore unavailable. This can happen if the database is still provisioning or if internet is blocked.");
      toast.error("Database Unavailable: The research vault is still waking up. Please wait 1 minute and refresh.", { id: 'fb-conn-err' });
    } else if (error.code === 'permission-denied') {
      console.warn("Connectivity Test: Document access restricted. This is normal if security rules are strictly enforced.");
    } else if (error.message.includes('the client is offline') || error.code === 'failed-precondition') {
      console.error("Please check your Firebase configuration or setup the database first.");
    }
  }
}

testConnection();
