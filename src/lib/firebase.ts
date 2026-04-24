import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, Timestamp } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

const googleProvider = new GoogleAuthProvider();

export const loginWithGoogle = () => signInWithPopup(auth, googleProvider);
export const logout = () => signOut(auth);

export interface Ticket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: 'Done' | 'In Progress' | 'Visit Scheduled' | 'Open';
  visitDate: string | null;
  contactName?: string | null;
  address?: string | null;
  userId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type TicketInput = Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'userId'>;

export function parseEmailHTML(html: string): { 
  ticketNumber: string; 
  subject: string; 
  status?: string; 
  contactName?: string; 
  address?: string; 
  visitDate?: string 
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const bodyText = doc.body?.innerText || html;
  
  // 1. Extraction helpers
  const extractField = (label: string) => {
    const regex = new RegExp(`${label}\\s*[:#]?\\s*(.*)`, 'i');
    const match = bodyText.match(regex);
    return match ? match[1].split('\n')[0].trim() : '';
  };

  // 2. Extract specific fields
  const ticketNumberMatch = bodyText.match(/(?:Ticket\s*#|ST-)\s*(\d{3,10})/i);
  const ticketNumber = ticketNumberMatch ? ticketNumberMatch[1] : '';
  
  const subject = extractField('Subject');
  const statusRaw = extractField('Status');
  const contactName = extractField('Contact name');
  const address = extractField('Address');

  // 3. Search for visit dates (e.g., 10/24/2026, Oct 24, 2026, 2026-10-24)
  const dateRegex = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4})\b/i;
  const dateMatches = bodyText.match(new RegExp(dateRegex, 'gi'));
  let visitDate = '';
  
  if (dateMatches) {
    // Usually the most recent or future-looking date in the thread is the visit date
    // For now, take the first one that isn't clearly a header date
    visitDate = dateMatches[0];
  }

  return { 
    ticketNumber, 
    subject: subject || (ticketNumber ? `Support Ticket ${ticketNumber}` : ''), 
    status: statusRaw,
    contactName,
    address,
    visitDate
  };
}

export function getStatusFromSubject(subject: string, statusRaw?: string): Ticket['status'] {
  const s = (statusRaw || subject).toLowerCase();
  
  if (s.includes('completed') || s.includes('confirmed') || s.includes('done')) return 'Done';
  if (s.includes('procurement') || s.includes('delivery') || s.includes('parts') || s.includes('in transit') || s.includes('in progress')) return 'In Progress';
  if (s.includes('scheduled') || s.includes('visit') || s.includes('on-site')) return 'Visit Scheduled';
  
  return 'Open';
}
