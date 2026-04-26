import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signOut, onAuthStateChanged, User } from 'firebase/auth';

import { getFirestore, collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, Timestamp, arrayUnion, writeBatch, documentId } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export { arrayUnion };

const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('https://www.googleapis.com/auth/gmail.readonly');
googleProvider.addScope('https://www.googleapis.com/auth/spreadsheets');
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

/**
 * CLIENT-SIDE GOOGLE IDENTITY SERVICES (GIS) IMPLEMENTATION
 * This avoids the "Unauthorized Domain" errors in Firebase Auth because it doesn't 
 * rely on the internal firebaseapp.com handler page.
 */
const CLIENT_ID = '422897157511-gm9kb0g8itqi9jugis86e8vllf70vrlg.apps.googleusercontent.com';

export const getGmailToken = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    const cached = sessionStorage.getItem('gmail_access_token');
    if (cached) {
      resolve(cached);
      return;
    }

    try {
      // @ts-ignore - GIS library is loaded in index.html
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/spreadsheets',
        callback: (response: any) => {
          if (response.error) {
            reject(new Error(response.error_description || response.error));
            return;
          }
          if (response.access_token) {
            sessionStorage.setItem('gmail_access_token', response.access_token);
            resolve(response.access_token);
          } else {
            reject(new Error('No access token received'));
          }
        },
      });
      client.requestAccessToken();
    } catch (err) {
      console.error("GIS Error:", err);
      reject(new Error('Google Identity Services not loaded yet. If you are using an ad-blocker, please disable it for this site and refresh.'));
    }
  });
};

export const loginWithGoogle = async () => {
  // We no longer use Firebase Auth for the app lifecycle login.
  // We use PIN login instead, and call getGmailToken only when needed.
  return getGmailToken();
};

export const hasGmailToken = () => !!sessionStorage.getItem('gmail_access_token');

export const logout = async () => {
  sessionStorage.removeItem('gmail_access_token');
};

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
  }
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export interface Ticket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string; // Dynamic status
  manualStatusOverride?: boolean; // Flag to stop auto-sync from overwriting
  brief?: string; // Short summary from content
  visitDate: string | null;
  contactName?: string | null;
  address?: string | null;
  userId: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  priority?: string;
  notes?: string;
  archived?: boolean; // For dismissing from board
  deletedAt?: Timestamp | null; // For soft delete / retention
  content?: string; // Full text content for display
  htmlContent?: string;
  processedMessageIds?: string[];
}

export type TicketInput = Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'userId'>;

export function extractVisitDate(content: string): string {
  const dateRegex = /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*,?\s*)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?,? \d{0,4})\b|today|tomorrow\b/i;
  const visitKeywords = ["will visit", "scheduled for", "technician will be on site", "plan to visit", "coming to campus"];
  
  const lowerContent = content.toLowerCase();
  const hasVisitKeyword = visitKeywords.some(kw => lowerContent.includes(kw));
  
  if (hasVisitKeyword) {
    // Look for a date in the same paragraph/line or nearby
    const m = content.match(dateRegex);
    if (m) return m[0];
  }

  return '';
}

export function parseEmailHTML(html: string, emailSubject?: string): { 
  ticketNumber: string; 
  subject: string; 
  status: string; 
  contactName: string; 
  address: string; 
  visitDate: string;
  brief: string;
  content: string;
  htmlContent: string;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const bodyText = (doc.body?.innerText || html).trim();
  
  // Isolate most recent message in thread
  const threadMarkers = [
    'From:', 
    'On ', 
    '---', 
    '____________', 
    'Get Outlook for',
    'Sent from my'
  ];
  
  let splitIndex = bodyText.length;
  for (const marker of threadMarkers) {
    const idx = bodyText.indexOf(marker);
    if (idx !== -1 && idx < splitIndex && idx > 5) {
      splitIndex = idx;
    }
  }
  
  const mostRecentMessage = bodyText.substring(0, splitIndex).trim();
  
  // 1. Extraction from Subject Line
  let ticketNumber = '';
  let subject = '';

  if (emailSubject) {
    const ticketMatch = emailSubject.match(/Ticket#(\s*\d+)/i);
    if (ticketMatch) ticketNumber = ticketMatch[1].trim();

    const subjectMatch = emailSubject.match(/(?:IL\s?Texas\s*-\s*)(.*?)\s*--/i) || 
                         emailSubject.match(/(?:-\s*)(.*?)\s*--/i);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
    } else {
      subject = emailSubject.replace(/^(FW|RE|FWD|CC):\s*/i, '').trim();
    }
  }

  // 2. Data Extraction
  const allElements = Array.from(doc.querySelectorAll('td, b, span, div, p, strong, label, th, font'));
  
  const findNextText = (label: string) => {
    let el = allElements.find(e => {
      const text = e.textContent?.trim().toLowerCase() || '';
      return text === label.toLowerCase() || text === `${label.toLowerCase()}:` || text === `${label.toLowerCase()} :`;
    });
    
    if (!el && label.length > 3) {
      el = allElements.find(e => {
        const text = e.textContent?.trim().toLowerCase() || '';
        return text.startsWith(label.toLowerCase()) && text.includes(':');
      });
    }

    if (!el) return '';
    
    const ownText = el.textContent || '';
    if (ownText.includes(':')) {
      const parts = ownText.split(':');
      if (parts.length > 1 && parts[1].trim().length > 0) return parts[1].trim();
    }

    if (el.nextElementSibling) {
      const text = el.nextElementSibling.textContent?.trim() || '';
      if (text) return text;
    }
    
    const parent = el.parentElement;
    if (parent) {
      const children = Array.from(parent.children);
      const idx = children.indexOf(el);
      if (idx !== -1 && idx < children.length - 1) {
        const nextVal = children[idx + 1].textContent?.trim();
        if (nextVal) return nextVal;
      }
    }

    if (parent && parent.nextElementSibling) {
      return parent.nextElementSibling.textContent?.trim() || '';
    }
    
    return '';
  };

  const bodyTicket = findNextText('Ticket#') || findNextText('Ticket #') || findNextText('Ticket Number');
  if (bodyTicket) {
    ticketNumber = bodyTicket.replace(/\D/g, '');
  }

  // Fallback regex for ticket number in body text
  if (!ticketNumber) {
    const bodyTicketMatch = mostRecentMessage.match(/(?:Ticket|Service Ticket)\s*#\s*(\d+)/i);
    if (bodyTicketMatch) {
      ticketNumber = bodyTicketMatch[1].trim();
    }
  }

  // Fallback for subject in body if outer subject is generic
  if (emailSubject && (emailSubject.toLowerCase().includes('received your email') || emailSubject.toLowerCase().includes('ticket confirmation'))) {
    const issueMatch = mostRecentMessage.match(/for issue:\s*(.*?)(?:\s*and it has been assigned|\.|\n|$)/i);
    if (issueMatch) {
      subject = issueMatch[1].trim();
    }
  }

  const contactName = findNextText('Contact name') || findNextText('Customer') || '';
  const address = findNextText('Address') || findNextText('Location') || '';
  
  const vDate = extractVisitDate(mostRecentMessage);

  // Extract a "brief"
  let brief = '';
  const signatureIdx = mostRecentMessage.search(/\b(thanks|thank you|sincerely|best|regards|reguards|sent from|this email|confidentiality notice)\b/i);
  brief = signatureIdx !== -1 ? mostRecentMessage.substring(0, signatureIdx).trim() : mostRecentMessage.substring(0, 300).trim();
  brief = brief.replace(/\s+/g, ' ').trim();
  if (brief.length > 400) brief = brief.substring(0, 397) + '...';

  return { 
    ticketNumber, 
    subject: subject || (ticketNumber ? `Support Ticket ${ticketNumber}` : 'Support Request'), 
    status: getStatusFromSubject('', '', mostRecentMessage), // Status derived ONLY from body text
    contactName,
    address,
    visitDate: vDate,
    brief,
    content: mostRecentMessage,
    htmlContent: html
  };
}

export function getStatusFromSubject(subject: string, statusRaw?: string, bodyContent?: string): string {
  const text = (bodyContent || '').toLowerCase();
  
  // 1. Scheduled
  const scheduledKeywords = ["will visit", "scheduled for", "technician will be on site", "plan to visit", "coming to campus"];
  const dateRegex = /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*,?\s*)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?,? \d{0,4})\b|today|tomorrow\b/i;
  
  const hasScheduledKeyword = scheduledKeywords.some(kw => text.includes(kw));
  if (hasScheduledKeyword && dateRegex.test(text)) {
    return 'Scheduled';
  }

  // 2. Done / Resolved
  const doneKeywords = ["resolved", "completed", "closed", "ticket has been closed", "work is complete"];
  if (doneKeywords.some(kw => text.includes(kw))) {
    return 'Done';
  }

  // 3. Waiting for Parts / Invoice
  if (text.includes('waiting for parts') || text.includes('parts on order')) return 'Waiting for Parts';
  if (text.includes('waiting for invoice') || text.includes('invoice sent')) return 'Waiting for Invoice';

  // 4. Open (Default)
  return 'Open';
}

export async function softDeleteTickets(ids: string[]) {
  const batch = writeBatch(db);
  ids.forEach(id => {
    const ticketRef = doc(db, 'tickets', id);
    batch.update(ticketRef, { 
      deletedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  });
  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'tickets/batch-delete');
  }
}
