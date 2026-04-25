import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { getFirestore, collection, query, where, onSnapshot, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, Timestamp, arrayUnion, writeBatch } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export { arrayUnion };

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
  deletedAt?: Timestamp | null; // For soft delete / retention
  content?: string; // Full text content for display
  htmlContent?: string;
  processedMessageIds?: string[];
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
    // Don't split if it's the very first word (unlikely but possible if email starts with from)
    if (idx !== -1 && idx < splitIndex && idx > 5) {
      splitIndex = idx;
    }
  }
  
  const mostRecentMessage = bodyText.substring(0, splitIndex).trim();
  const fullContent = (doc.body?.innerHTML || html);
  
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

  // 2. HTML-Specific Extraction
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

    // Try sibling/parent-sibling
    if (el.nextElementSibling) {
      const text = el.nextElementSibling.textContent?.trim() || '';
      if (text) return text;
    }
    
    // Check parent's children (common for labels next to text)
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
    
    const tdParent = el.closest('td');
    if (tdParent && tdParent.nextElementSibling) {
      return tdParent.nextElementSibling.textContent?.trim() || '';
    }

    return '';
  };

  const bodyTicket = findNextText('Ticket#') || findNextText('Ticket #') || findNextText('Ticket Number') || findNextText('Ticket ID') || findNextText('Support Ticket');
  const statusRaw = findNextText('Status') || findNextText('Ticket Status') || findNextText('Current Status') || '';
  const bodySubject = findNextText('Summary') || findNextText('Subject') || findNextText('Description') || findNextText('Case Subject') || '';
  
  if (bodyTicket) {
    ticketNumber = bodyTicket.replace(/\D/g, '');
  } 
  
  if (!ticketNumber) {
    const bodyTicketMatch = bodyText.match(/Ticket#\s*(\d+)/i) || 
                            bodyText.match(/Ticket\s*#\s*:?\s*(\d+)/i) ||
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

  const contactName = findNextText('Contact name') || findNextText('Customer') || findNextText('Contact') || '';
  const address = findNextText('Address') || findNextText('Location') || '';

  const dateRegex = /\b((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*,?\s*)?(\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?,? \d{0,4})\b|today|tomorrow\b/i;
  const visitContextRegex = /visit|schedule|cable team|technician|on-site|arrival|onsite|out today|out next week/i;
  
  let visitDate = '';
  // Be more aggressive searching for visit dates in the whole body if context is near
  const contextLines = mostRecentMessage.split('\n').filter(line => visitContextRegex.test(line));
  for (const line of contextLines) {
    const dateMatch = line.match(dateRegex);
    if (dateMatch) {
      visitDate = dateMatch[0];
      break;
    }
  }

  if (!visitDate) {
    const contextElements = Array.from(doc.querySelectorAll('p, tr, div, li, span')).filter(el => 
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
    'ready to be picked up',
    'technician is scheduled',
    'cable team is scheduled'
  ];

  for (const phrase of statusPhrases) {
    if (mostRecentMessage.toLowerCase().includes(phrase)) {
      const sentences = mostRecentMessage.split(/[.!?]+/);
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
    const welcomeMatch = mostRecentMessage.match(/(?:Good afternoon|Good morning|Hello|Hi)\s+[^,]+,\s*(.+)/i) ||
                         mostRecentMessage.match(/(?:Good afternoon|Good morning|Hello|Hi),\s*(.+)/i);
    if (welcomeMatch) {
      const remaining = (welcomeMatch[1] || '').trim();
      const signatureIdx = remaining.search(/\b(thanks|thank you|sincerely|best|regards|reguards|sent from|this email|confidentiality notice)\b/i);
      brief = signatureIdx !== -1 ? remaining.substring(0, signatureIdx).trim() : remaining.substring(0, 300).trim();
    }
  }

  if (!brief) {
    let lines = mostRecentMessage.split('\n').map(l => l.trim()).filter(l => l.length > 10);
    let candidate = lines.find(l => l.length > 40 && !l.includes(':'));
    if (candidate) {
      brief = candidate;
    } else {
      let cleanedFallback = mostRecentMessage.replace(/^(?:from|sent|to|cc|subject|importance|priority):.*$/gmi, '').trim();
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
    status: getStatusFromSubject(subject, statusRaw, mostRecentMessage),
    contactName: contactName || '',
    address: address || '',
    visitDate: visitDate || '',
    brief,
    content: mostRecentMessage,
    htmlContent: html
  };
}

export function getStatusFromSubject(subject: string, statusRaw?: string, bodyContent?: string): string {
  // 1. If we have a clear status from the ticket body, use it but map to categories for colors
  if (statusRaw && statusRaw.trim()) {
    const s = statusRaw.trim();
    const sl = s.toLowerCase();
    
    if (sl.includes('complete') || sl.includes('resolve') || sl.includes('closed') || sl.includes('solved') || sl.includes('done')) return 'Done';
    if (sl.includes('scheduled') || sl.includes('visit')) return 'Visit Scheduled';
    
    // Be more specific with "Waiting for Part" so it doesn't catch "Waiting on External Support"
    // Be more specific with "Waiting for Part" so it doesn't catch others
    if ((sl.includes('waiting') && sl.includes('part')) || sl.includes('part on order') || sl.includes('procurement')) return 'Waiting for Part';
    
    if (sl.includes('progress') || sl.includes('working')) return 'In Progress';

    // If it's any other specific status we found, just return it as is (e.g. "Waiting on External Support")
    return s;
  }

  const combined = (subject + ' ' + (bodyContent || '')).toLowerCase();
  
  // 2. Keyword-based discovery for emails without explicit status lines
  const doneKeywords = [
    'completed', 'confirmed the request has been completed', 'resolution has been applied',
    'solved', 'closed', 'resolved', 'fixed', 'completed successfully',
    'request has been completed', 'completed on our end', 'completed on their end',
    'confirmed completion', 'issue should be resolved', 'issue is resolved'
  ];

  if (doneKeywords.some(keyword => combined.includes(keyword))) {
    return 'Done';
  }
  
  const scheduledKeywords = [
    'scheduled for', 'scheduled a visit', 'visit is scheduled',
    'team will be out', 'team will be onsite', 'technician is scheduled',
    'scheduled to arrive', 'onsite visit', 'visit scheduled'
  ];

  if (scheduledKeywords.some(keyword => combined.includes(keyword))) {
    return 'Visit Scheduled';
  }

  // 3. Lower confidence fallbacks
  if (combined.includes('visit') || combined.includes('technician') || combined.includes('on-site')) return 'Visit Scheduled';
  if (combined.includes('procurement') || combined.includes('parts') || combined.includes('waiting for part')) return 'Waiting for Part';
  if (combined.includes('in progress') || combined.includes('working') || combined.includes('transit')) return 'In Progress';
  
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
  await batch.commit();
}
