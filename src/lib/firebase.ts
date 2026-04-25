import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, Timestamp } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

const googleProvider = new GoogleAuthProvider();
googleProvider.addScope('https://www.googleapis.com/auth/gmail.readonly');

export const loginWithGoogle = async () => {
  const result = await signInWithPopup(auth, googleProvider);
  const credential = GoogleAuthProvider.credentialFromResult(result);
  const token = credential?.accessToken || null;
  if (token) {
    sessionStorage.setItem('gmail_access_token', token);
  }
  return result;
};

export const hasGmailToken = () => !!sessionStorage.getItem('gmail_access_token');

export const getGmailToken = async () => {
  const cached = sessionStorage.getItem('gmail_access_token');
  if (cached) return cached;
  
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const token = credential?.accessToken || null;
    if (token) {
      sessionStorage.setItem('gmail_access_token', token);
    }
    return token;
  } catch (error: any) {
    console.error("Gmail Auth Error:", error);
    if (error.code === 'auth/cancelled-popup-request') {
      throw new Error('A previous authentication request is still pending. Please wait or refresh the page.');
    }
    if (error.code === 'auth/the-service-is-currently-unavailable') {
      throw new Error('Google Auth Service is currently unavailable in this view. Please click "Open in New Tab" at the top and try again.');
    }
    throw error;
  }
};

export const logout = () => signOut(auth);

export interface Ticket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string; // Dynamic status
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
  content?: string; // Full text content for display
  htmlContent?: string;
}

export type TicketInput = Omit<Ticket, 'id' | 'createdAt' | 'updatedAt' | 'userId'>;

export function parseEmailHTML(html: string, emailSubject?: string): { 
  ticketNumber: string; 
  subject: string; 
  status: string; 
  contactName: string; 
  address: string; 
  visitDate: string;
  brief: string;
  content: string;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const bodyText = (doc.body?.innerText || html).replace(/\s+/g, ' ').trim();
  const fullContent = (doc.body?.innerHTML || html);
  
  // 1. Extraction from Subject Line
  let ticketNumber = '';
  let subject = '';

  if (emailSubject) {
    const ticketMatch = emailSubject.match(/Ticket#(\d+)/i);
    if (ticketMatch) ticketNumber = ticketMatch[1];

    const subjectMatch = emailSubject.match(/(?:IL\s?Texas\s*-\s*)(.*?)\s*--/i) || 
                         emailSubject.match(/(?:-\s*)(.*?)\s*--/i);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
    } else {
      subject = emailSubject.replace(/^(FW|RE|FWD|CC):\s*/i, '').trim();
    }
  }

  // 2. HTML-Specific Extraction
  const allElements = Array.from(doc.querySelectorAll('td, b, span, div, p, strong, label, th'));
  
  const findNextText = (label: string) => {
    let el = allElements.find(e => {
      const text = e.textContent?.trim().toLowerCase() || '';
      return text === label.toLowerCase() || text === `${label.toLowerCase()}:`;
    });
    
    if (!el && label.length > 3) {
      el = allElements.find(e => e.textContent?.trim().toLowerCase().includes(label.toLowerCase()));
    }

    if (!el) return '';
    
    const ownText = el.textContent || '';
    if (ownText.includes(':')) {
      const parts = ownText.split(':');
      if (parts.length > 1 && parts[1].trim().length > 0) return parts[1].trim();
    }

    if (el.nextElementSibling) return el.nextElementSibling.textContent?.trim() || '';
    
    const parent = el.parentElement;
    if (parent && parent.nextElementSibling) {
      return parent.nextElementSibling.textContent?.trim() || '';
    }
    
    const tdParent = el.closest('td');
    if (tdParent && tdParent.nextElementSibling) {
      return tdParent.nextElementSibling.textContent?.trim() || '';
    }

    return '';
  };

  const bodyTicket = findNextText('Ticket#') || findNextText('Ticket Number') || findNextText('Ticket ID') || findNextText('Support Ticket');
  const statusRaw = findNextText('Status') || findNextText('Ticket Status') || findNextText('Current Status') || '';
  const bodySubject = findNextText('Summary') || findNextText('Subject') || findNextText('Description') || findNextText('Case Subject') || '';
  
  if (bodyTicket) {
    ticketNumber = bodyTicket.replace(/\D/g, '');
  } 
  
  if (!ticketNumber) {
    const bodyTicketMatch = bodyText.match(/Ticket#\s*(\d+)/i) || 
                            bodyText.match(/Ticket\s*Number\s*:?\s*(\d+)/i) ||
                            bodyText.match(/Ticket\s*ID\s*:?\s*(\d+)/i) ||
                            bodyText.match(/T#\s*:?\s*(\d+)/i) ||
                            bodyText.match(/Support\s*Ticket\s*:?\s*(\d+)/i);
    if (bodyTicketMatch) ticketNumber = bodyTicketMatch[1];
  }

  if (!ticketNumber) {
    const lines = bodyText.split('\n');
    for (const line of lines) {
      if (/ticket|request|case|splendid/i.test(line)) {
        const m = line.match(/\b(\d{5,6})\b/);
        if (m) {
          ticketNumber = m[1];
          break;
        }
      }
    }
  }

  if (bodySubject) subject = bodySubject;

  const contactName = findNextText('Contact name') || findNextText('Customer') || '';
  const address = findNextText('Address') || findNextText('Location') || '';

  const dateRegex = /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*,?\s*)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4})\b/i;
  const visitContextRegex = /visit|schedule|cable team|technician|on-site|arrival|onsite/i;
  
  let visitDate = '';
  const contextElements = Array.from(doc.querySelectorAll('p, tr, div, li')).filter(el => 
    visitContextRegex.test(el.textContent || '')
  );

  for (const el of contextElements) {
    const text = el.textContent || '';
    const dateMatch = text.match(dateRegex);
    if (dateMatch) {
      visitDate = dateMatch[0];
      break;
    }
  }

  // Extract a "brief" - find the first meaningful block of text
  let brief = '';
  
  // High priority: check for specific status sentences to include them in the brief
  const statusPhrases = [
    'confirmed the request has been completed',
    'completed on their end',
    'completed on our end',
    'request has been completed',
    'shipped the amp',
    'FedEx is estimating it should arrive',
    'ready to be picked up'
  ];

  for (const phrase of statusPhrases) {
    if (bodyText.toLowerCase().includes(phrase)) {
      // Find the sentence containing this phrase
      const sentences = bodyText.split(/[.!?]+/);
      const matchingSentence = sentences.find(s => s.toLowerCase().includes(phrase));
      if (matchingSentence) {
        brief = matchingSentence.trim() + '.';
        break;
      }
    }
  }

  if (!brief) {
    // Try to find a "Message" or "Update" block
    const meaningfulMarkers = ['message:', 'update:', 'summary:', 'description:', 'latest update:', 'updated by'];
    for (const marker of meaningfulMarkers) {
      const idx = bodyText.toLowerCase().indexOf(marker);
      if (idx !== -1) {
        const remaining = bodyText.substring(idx + marker.length).trim();
        // Skip names if marker was "updated by"
        let actualText = remaining;
        if (marker === 'updated by') {
          const firstColon = remaining.indexOf(':');
          if (firstColon !== -1 && firstColon < 50) {
            actualText = remaining.substring(firstColon + 1).trim();
          }
        }
        
        const signatureIdx = actualText.search(/\b(thanks|thank you|sincerely|best|regards|reguards|sent from|this email|confidentiality notice)\b/i);
        brief = signatureIdx !== -1 ? actualText.substring(0, signatureIdx).trim() : actualText.substring(0, 300).trim();
        break;
      }
    }
  }

  if (!brief) {
    // Look for pleasantries
    const welcomeMatch = bodyText.match(/(?:Good afternoon|Good morning|Hello|Hi)\s+[^,]+,\s*(.+)/i) ||
                         bodyText.match(/(?:Good afternoon|Good morning|Hello|Hi),\s*(.+)/i);
    if (welcomeMatch) {
      const remaining = (welcomeMatch[1] || '').trim();
      const signatureIdx = remaining.search(/\b(thanks|thank you|sincerely|best|regards|reguards|sent from|this email|confidentiality notice)\b/i);
      brief = signatureIdx !== -1 ? remaining.substring(0, signatureIdx).trim() : remaining.substring(0, 300).trim();
    }
  }

  if (!brief) {
    // Fallback: take first block of text from 3rd line or so (skipping headers)
    let lines = bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let candidate = lines.find(l => l.length > 40 && !l.includes(':'));
    if (candidate) {
      brief = candidate;
    } else {
      let cleanedFallback = bodyText.replace(/^(?:from|sent|to|cc|subject|importance|priority):.*$/gmi, '').trim();
      brief = cleanedFallback.substring(0, 250).trim();
      if (cleanedFallback.length > 250) brief += '...';
    }
  }

  // Final cleanup of the brief
  brief = brief.replace(/\s+/g, ' ').replace(/^["']+|["']+$/g, '').trim();
  if (brief.length > 400) brief = brief.substring(0, 397) + '...';

  return { 
    ticketNumber, 
    subject: subject || (ticketNumber ? `Support Ticket ${ticketNumber}` : 'Support Request'), 
    status: getStatusFromSubject(subject, statusRaw, brief),
    contactName: contactName || '',
    address: address || '',
    visitDate: visitDate || '',
    brief,
    content: bodyText,
    htmlContent: html
  };
}

export function getStatusFromSubject(subject: string, statusRaw?: string, bodyContent?: string): string {
  const combined = (subject + ' ' + (bodyContent || '')).toLowerCase();
  
  // Terminal status keywords (Done/Resolved)
  const doneKeywords = [
    'completed', 'confirmed', 'solved', 'done', 'closed', 'resolved',
    'completed on our end', 'completed on their end', 
    'request has been completed', 'confirmed the request has been completed',
    'request has been closed', 'fix has been applied', 'issue is resolved',
    'thank you for your help', 'closed out', 'has been resolved', 'fixed',
    'issue should be resolved', 'marked as completed', 'resolved this morning',
    'successfully resolved', 'ticket is now closed'
  ];

  if (doneKeywords.some(keyword => combined.includes(keyword))) {
    return 'Done';
  }

  // Backup: specific statusRaw from Gmail / Ticket header
  if (statusRaw && statusRaw.trim() && !statusRaw.toLowerCase().includes('open') && !statusRaw.toLowerCase().includes('new')) {
    return statusRaw.trim();
  }
  
  if (combined.includes('scheduled') || combined.includes('visit') || combined.includes('on-site') || combined.includes('arrival')) return 'Visit Scheduled';
  if (combined.includes('procurement') || combined.includes('delivery') || combined.includes('parts') || combined.includes('waiting for part')) return 'Waiting for Part';
  if (combined.includes('in transit') || combined.includes('in progress') || combined.includes('working')) return 'In Progress';
  
  return 'Open';
}
