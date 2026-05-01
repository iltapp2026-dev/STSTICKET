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
  isFlagged?: boolean;
}

export type TicketInput = Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'userId'>;

export function extractVisitDate(content: string, referenceDate?: Date): string {
  const dateRegex = /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*,?\s*)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?,? \d{0,4})\b/i;
  const visitKeywords = ["will visit", "scheduled for", "technician will be on site", "plan to visit", "coming to campus", "will install", "scheduled to install", "scheduled for install"];
  
  const lowerContent = content.toLowerCase();
  const ref = referenceDate || new Date();
  
  // Handle relative terms relative to email date
  if (lowerContent.includes('tomorrow') && (visitKeywords.some(kw => lowerContent.includes(kw)) || lowerContent.includes('visit'))) {
    const tomorrow = new Date(ref);
    tomorrow.setDate(ref.getDate() + 1);
    const y = tomorrow.getFullYear();
    const m = tomorrow.getMonth() + 1;
    const d = tomorrow.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  
  if (lowerContent.includes('today') && (visitKeywords.some(kw => lowerContent.includes(kw)) || lowerContent.includes('visit'))) {
    const y = ref.getFullYear();
    const m = ref.getMonth() + 1;
    const d = ref.getDate();
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  const hasVisitKeyword = visitKeywords.some(kw => lowerContent.includes(kw));
  // Be VERY strict - only extract visit date if there is a clear visit keyword
  if (hasVisitKeyword) {
    const m = content.match(dateRegex);
    if (m) {
      const dateStr = m[0];
      try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) {
          const y = d.getFullYear();
          const month = d.getMonth() + 1;
          const dayCount = d.getDate();
          return `${y}-${String(month).padStart(2, '0')}-${String(dayCount).padStart(2, '0')}`;
        }
      } catch (e) {}
      return dateStr;
    }
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
  createdAt: Timestamp | null;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  
  // Remove script and style elements to get cleaner text
  const scripts = doc.querySelectorAll('script, style');
  scripts.forEach(s => s.remove());
  
  const bodyText = (doc.body?.innerText || html || '').trim();
  
  // 1. Extraction from Subject Line
  let ticketNumber = '';
  let subject = '';

  if (emailSubject) {
    // Improved detection for Service Ticket #92000, #92000, Ticket 92000
    const ticketMatch = emailSubject.match(/(?:(?:Service\s+)?Ticket\s*(?:#|:)?|#)\s*(\d+)/i) || 
                         bodyText.match(/(?:(?:Service\s+)?Ticket\s*(?:#|:)?|#)\s*(\d+)/i);
    if (ticketMatch) ticketNumber = ticketMatch[1].trim();

    const subjectMatch = emailSubject.match(/(?:IL\s?Texas\s*-\s*)(.*?)\s*--/i) || 
                         emailSubject.match(/(?:-\s*)(.*?)\s*--/i) ||
                         bodyText.match(/request for ["'](.*?)["']/i) ||
                         bodyText.match(/issue:\s*(.*?)(?:\s*and it has been assigned|\.|\n|$)/i);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
    } else {
      subject = emailSubject.replace(/^(FW|RE|FWD|CC):\s*/i, '')
                            .replace(/Service Ticket\s*#\d+\s*has been received/i, 'Service Request')
                            .replace(/Ticket\s*#\d+/i, '')
                            .trim();
      if (!subject || subject === '-') subject = 'Service Request';
    }
  }

  // 1. Isolate the "Header Block" vs "Message Body"
  const headerBlockMarkers = [
    '---------- Forwarded message ----------',
    'From:', 
    'Sent:',
    'Date:',
    'Subject:',
    'To:',
    'Cc:'
  ];

  // Extract "Original Date" from the text following a Date/Sent prefix
  let parsedCreatedAt: Timestamp | null = null;
  const dateLinePrefixes = ['Date:', 'Sent:', 'Originally sent:'];

  // Robust cleanup of headers - catching Narrow No-Break Space and other UTF-8 variants
  const firstSection = bodyText.substring(0, 3000);
  const cleanerHeaderArea = firstSection
    .replace(/[\u202F\u2000-\u200B\uFEFF\xA0]/g, ' ') 
    .replace(/[^\x20-\x7E\s]/g, ' '); 

  const headerDateLinePrefixes = ['Date:', 'Sent:', 'Originally sent:', 'On '];
  const headerLines = cleanerHeaderArea.split('\n');

  for (const line of headerLines) {
    const trimmed = line.trim();
    if (headerDateLinePrefixes.some(p => trimmed.toLowerCase().startsWith(p.toLowerCase()))) {
      // Matches: Tuesday, April 14, 2026 or 14 April 2026
      const dateRegex = /(?:[A-Z][a-z]+,?\s+)?([A-Z][a-z]+\s+\d{1,2}(?:st|nd|rd|th)?\s*,?\s*\d{4})|(\d{1,2}\s+[A-Z][a-z]+\s*,?\s*\d{4})/i;
      const match = trimmed.match(dateRegex);
      
      if (match) {
        const dateStr = (match[1] || match[2]).trim();
        try {
          const cleanPart = dateStr.split(/\s+at\s+/i)[0].trim();
          const d = new Date(cleanPart);
          if (!isNaN(d.getTime())) {
            parsedCreatedAt = Timestamp.fromDate(d);
            break;
          }
        } catch (e) {}
      }
    }
  }

  const lines = bodyText.split(/\r?\n/);
  const content = bodyText;
  
  // Identify where real content starts
  let contentStartIdx = 0;
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const line = lines[i].trim();
    if (line.toLowerCase().startsWith('subject:')) {
      contentStartIdx = i + 1;
      while (contentStartIdx < lines.length && (lines[contentStartIdx].trim() === '' || lines[contentStartIdx].includes(': '))) {
        contentStartIdx++;
      }
      break;
    }
  }

  const mostRecentLines = lines.slice(contentStartIdx);
  const mostRecentMessage = mostRecentLines.join('\n').trim();
  
  const searchableForVisitDate = mostRecentLines
    .filter(line => {
      const l = line.trim().toLowerCase();
      return !l.startsWith('from:') && !l.startsWith('to:') && !l.startsWith('date:') && 
             !l.startsWith('sent:') && !l.startsWith('subject:') && !l.startsWith('cc:');
    })
    .join('\n');

  // Context-aware visit date extraction
  const referenceDate = parsedCreatedAt ? parsedCreatedAt.toDate() : new Date();
  const vDate = extractVisitDate(searchableForVisitDate, referenceDate);

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

  if (!ticketNumber) {
    const bodyTicketMatch = bodyText.match(/(?:Service\s+)?Ticket\s*#?\s*:?\s*(\d+)/i);
    if (bodyTicketMatch) {
      ticketNumber = bodyTicketMatch[1].trim();
    }
  }

  if (ticketNumber && !subject) {
    subject = `Service Request #${ticketNumber}`;
  }

  const contactName = findNextText('Contact name') || findNextText('Customer') || '';
  const address = findNextText('Address') || findNextText('Location') || '';
  
  // Extract a "brief"
  let brief = '';
  const signatureIdx = mostRecentMessage.search(/\b(thanks|thank you|sincerely|best|regards|reguards|sent from|this email|confidentiality notice)\b/i);
  brief = signatureIdx !== -1 ? mostRecentMessage.substring(0, signatureIdx).trim() : mostRecentMessage.substring(0, 300).trim();
  brief = brief.replace(/\s+/g, ' ').trim();
  if (brief.length > 400) brief = brief.substring(0, 397) + '...';

  const finalStatus = getStatusFromSubject('', '', searchableForVisitDate);

  return { 
    ticketNumber, 
    subject: subject || (ticketNumber ? `Support Ticket ${ticketNumber}` : 'Support Request'), 
    status: finalStatus === 'Scheduled' ? 'Visit Scheduled' : finalStatus, 
    contactName,
    address,
    visitDate: vDate,
    brief,
    content: mostRecentMessage,
    htmlContent: html,
    createdAt: parsedCreatedAt
  };
}

export function getStatusFromSubject(subject: string, statusRaw?: string, bodyContent?: string): string {
  const text = (bodyContent || '').toLowerCase();
  
  // 0. Urgent (Red Flag)
  if (text.includes('red flag') || text.includes('urgent') || text.includes('priority 1') || text.includes('p1')) {
    return 'Urgent';
  }

  // 1. Scheduled
  const scheduledKeywords = ["will visit", "scheduled for", "technician will be on site", "plan to visit", "coming to campus", "will install", "scheduled to install", "scheduled for install"];
  const dateRegex = /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*,?\s*)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?,? \d{0,4})\b|today|tomorrow\b/i;
  
  const hasScheduledKeyword = scheduledKeywords.some(kw => text.includes(kw));
  if (hasScheduledKeyword && dateRegex.test(text)) {
    return 'Visit Scheduled';
  }

  // 2. Done / Resolved
  const doneKeywords = ["resolved", "completed", "closed", "ticket has been closed", "work is complete"];
  if (doneKeywords.some(kw => text.includes(kw))) {
    return 'Done';
  }

  // 3. Waiting for Parts / Invoice
  if (text.includes('waiting for parts') || text.includes('parts on order')) return 'Waiting for Parts';
  if (text.includes('waiting for invoice') || text.includes('invoice sent')) return 'Waiting for Invoice';

  // 4. Open (Default / Received)
  if (text.includes('received') || text.includes('assigned')) return 'Open';
  return 'Open';
}

export function checkIfUrgent(subject: string, body: string): boolean {
  const combined = (subject + ' ' + body).toLowerCase();
  const urgentKeywords = ["red flag", "urgent", "critical", "emergency", "asap", "priority 1", "p1"];
  return urgentKeywords.some(kw => combined.includes(kw));
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
