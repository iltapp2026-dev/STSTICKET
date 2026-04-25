/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  LogOut, 
  Search, 
  Plus, 
  Filter, 
  CheckCircle2, 
  Clock, 
  Calendar, 
  AlertCircle, 
  X, 
  LayoutDashboard,
  ChevronRight,
  Loader2,
  Trash2,
  CalendarCheck,
  FileText,
  Mail,
  RefreshCw,
  Download,
  ListChecks,
  ShieldAlert,
  Upload,
  History
} from 'lucide-react';
import { 
  format, 
  isSameDay, 
  isThursday, 
  isBefore, 
  setHours, 
  setMinutes, 
  startOfDay,
  startOfWeek,
  endOfWeek,
  isWithinInterval,
  subWeeks,
  addWeeks,
  isSameWeek
} from 'date-fns';
import { useAuth, useTickets } from './lib/hooks';
import { 
  loginWithGoogle, 
  getGmailToken,
  logout, 
  getStatusFromSubject, 
  parseEmailHTML,
  Ticket, 
  db,
  auth
} from './lib/firebase';
import { collection, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const isResolved = s === 'done' || s.includes('complete') || s.includes('resolved') || s.includes('closed') || s.includes('solved');
  const isInProgress = s === 'in progress' || s.includes('transit') || s.includes('waiting for part') || s.includes('visit') || s.includes('scheduled');
  
  let bgColor = 'bg-red-500';
  let textColor = 'text-white';
  let borderColor = 'border-red-400';
  let animateClass = 'animate-[pulse_1.5s_infinite] ring-4 ring-red-500/40';
  
  if (isResolved) {
    bgColor = 'bg-emerald-500';
    borderColor = 'border-emerald-400';
    animateClass = ''; 
  } else if (isInProgress) {
    bgColor = 'bg-amber-400';
    textColor = 'text-amber-950';
    borderColor = 'border-amber-300';
    animateClass = 'ring-2 ring-amber-400/30'; // subtle ring, no pulse
  }

  return (
    <div 
      className={cn(
        "flex items-center gap-2 px-4 py-2 rounded-full border text-[10px] font-black uppercase tracking-[0.15em] w-fit min-w-[120px] justify-center transition-all shadow-lg",
        bgColor,
        textColor,
        borderColor,
        animateClass
      )}
    >
      <div className="w-1.5 h-1.5 rounded-full bg-white/90 shadow-[0_0_8px_rgba(255,255,255,0.8)]" />
      {status}
    </div>
  );
}

export default function App() {
  const { user, loading: authLoading } = useAuth();
  const [isGuestViewer, setIsGuestViewer] = useState(false);
  const [pin, setPin] = useState(() => localStorage.getItem('sts_pin') || '');
  const [adminLevel, setAdminLevel] = useState<'assistant' | 'full' | null>(() => {
    const saved = localStorage.getItem('sts_admin_level');
    return (saved === 'assistant' || saved === 'full') ? saved : null;
  });
  const [loginMode, setLoginMode] = useState<'admin' | 'viewer'>('admin');
  const [autoSync, setAutoSync] = useState(false);
  
  const [hideCompleted, setHideCompleted] = useState(false);
  
  const isAdmin = !!user || adminLevel === 'full';
  const isAssistant = adminLevel === 'assistant';
  const isViewer = !!localStorage.getItem('sts_viewer') || isGuestViewer || isAdmin || isAssistant;
  const isAuthenticated = isAdmin || isAssistant || isViewer;
  const canAccessFullAdmin = adminLevel === 'full' || (user?.email === 'iltapp2026@gmail.com');
  const canAccessAdmin = isAdmin || isAssistant;

  useEffect(() => {
    if (adminLevel) localStorage.setItem('sts_admin_level', adminLevel);
    else localStorage.removeItem('sts_admin_level');
  }, [adminLevel]);

  useEffect(() => {
    if (isGuestViewer) localStorage.setItem('sts_viewer', 'true');
    else localStorage.removeItem('sts_viewer');
  }, [isGuestViewer]);
  
  // If admin, they see their own (or all if we want shared). 
  // User says "my team can access it", so let's make it shared.
  // Actually, the previous implementation used user.uid. 
  // Let's use 'ALL' for viewer and maybe also for admin if it's meant to be a team dashboard.
  // Given "support@splendidtechnology.com" and "my team", shared is better.
  const activeUserId = isAdmin ? 'ALL' : (isViewer ? 'ALL' : null);
  
  const { tickets, loading: ticketsLoading } = useTickets(activeUserId);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<Ticket['status'] | 'All'>('All');
  const [view, setView] = useState<'dashboard' | 'activity' | 'reports'>('dashboard');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingTicket, setEditingTicket] = useState<Ticket | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);

  // Import related state
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importMode, setImportMode] = useState<'gmail' | 'manual'>('gmail');
  const [manualContent, setManualContent] = useState('');
  const [manualTicketNumber, setManualTicketNumber] = useState('');
  const [selectableEmails, setSelectableEmails] = useState<any[]>([]);
  const [selectedEmailIds, setSelectedEmailIds] = useState<Set<string>>(new Set());
  const [isFetchingEmails, setIsFetchingEmails] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const selectedWeek = useMemo(() => {
    const d = addWeeks(new Date(), weekOffset);
    return {
      start: startOfWeek(d, { weekStartsOn: 1 }),
      end: endOfWeek(d, { weekStartsOn: 1 })
    };
  }, [weekOffset]);


  const activityGroups = useMemo(() => {
    const today = startOfDay(new Date());
    const weekTickets = tickets.filter(t => {
      const date = t.updatedAt?.toDate ? t.updatedAt.toDate() : new Date();
      return isWithinInterval(date, selectedWeek);
    });

    return {
      completed: weekTickets.filter(t => t.status.toLowerCase().includes('done') || t.status.toLowerCase().includes('complete')),
      scheduled: tickets.filter(t => {
        const d = t.visitDate ? new Date(t.visitDate) : null;
        return (t.status.toLowerCase().includes('visit') || t.status.toLowerCase().includes('scheduled')) && 
               d && 
               (isSameDay(d, today) || d > today) &&
               isWithinInterval(d, selectedWeek);
      }),
      waiting: weekTickets.filter(t => !t.status.toLowerCase().includes('done')),
      updated: weekTickets.sort((a, b) => {
        const da = a.updatedAt?.toDate ? a.updatedAt.toDate().getTime() : 0;
        const db = b.updatedAt?.toDate ? b.updatedAt.toDate().getTime() : 0;
        return db - da;
      }).slice(0, 10)
    };
  }, [tickets, selectedWeek]);

  // Form state
  const [ticketNumber, setTicketNumber] = useState('');
  const [subject, setSubject] = useState('');
  const [visitDate, setVisitDate] = useState('');
  const [contactName, setContactName] = useState('');
  const [address, setAddress] = useState('');

  const filteredTickets = useMemo(() => {
    return tickets.filter(t => {
      const matchesSearch = t.ticketNumber.toLowerCase().includes(search.toLowerCase()) || 
                            t.subject.toLowerCase().includes(search.toLowerCase());
      
      const s = t.status.toLowerCase();
      const isResolved = s === 'done' || s.includes('complete') || s.includes('resolved') || s.includes('closed') || s.includes('solved');
      const isInProgress = s === 'in progress' || s.includes('transit') || s.includes('waiting for part') || s.includes('visit') || s.includes('scheduled');
      const isOpen = !isResolved && !isInProgress;

      let matchesStatus = statusFilter === 'All';
      if (statusFilter === 'Resolved') matchesStatus = isResolved;
      if (statusFilter === 'In Progress') matchesStatus = isInProgress;
      if (statusFilter === 'Open') matchesStatus = isOpen;
      if (statusFilter !== 'All' && statusFilter !== 'Resolved' && statusFilter !== 'In Progress' && statusFilter !== 'Open') {
        matchesStatus = t.status === statusFilter;
      }

      const notArchived = !t.archived;
      const hideCompletedFilter = !hideCompleted || !isResolved;
      
      return matchesSearch && matchesStatus && notArchived && hideCompletedFilter;
    });
  }, [tickets, search, statusFilter, hideCompleted]);

  useEffect(() => {
    // Background auto-corrector for statuses based on intelligence
    if (tickets.length > 0) {
      tickets.forEach(ticket => {
        if (ticket.status === 'Done' || ticket.archived) return;
        
        // Use full content if available, otherwise fallback to brief
        const intelligentStatus = getStatusFromSubject(ticket.subject, undefined, ticket.content || ticket.brief);
        if (intelligentStatus === 'Done' && ticket.status !== 'Done') {
          console.log(`Auto-correcting ticket #${ticket.ticketNumber} to Done based on content`);
          updateDoc(doc(db, 'tickets', ticket.id), {
            status: 'Done',
            updatedAt: serverTimestamp()
          }).catch(err => console.error("Auto-correct failed:", err));
        }
      });
    }
  }, [tickets]); // Run when tickets update

  const stats = useMemo(() => {
    const counts = { total: 0, open: 0, progress: 0, done: 0 };
    tickets.forEach(t => {
      if (t.archived) return;
      counts.total++;
      const s = t.status.toLowerCase();
      const isResolved = s === 'done' || s.includes('complete') || s.includes('resolved') || s.includes('closed') || s.includes('solved');
      const isInProgress = s === 'in progress' || s.includes('transit') || s.includes('waiting for part') || s.includes('visit') || s.includes('scheduled');
      
      if (isResolved) counts.done++;
      else if (isInProgress) counts.progress++;
      else counts.open++;
    });
    return counts;
  }, [tickets]);

  const upcomingVisits = useMemo(() => {
    const today = startOfDay(new Date());
    return tickets
      .filter(t => (t.status.toLowerCase().includes('visit') || t.status.toLowerCase().includes('scheduled')) && t.visitDate)
      .filter(t => {
        const d = new Date(t.visitDate!);
        return !isNaN(d.getTime()) && (isSameDay(d, today) || d > today);
      })
      .sort((a, b) => new Date(a.visitDate!).getTime() - new Date(b.visitDate!).getTime());
  }, [tickets]);

  const isShowBanner = useMemo(() => {
    const now = new Date();
    return isThursday(now) && isBefore(now, setMinutes(setHours(now, 10), 0));
  }, []);

  const handleSaveTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !editingTicket) return;

    const data = {
      ticketNumber,
      subject,
      status: getStatusFromSubject(subject, undefined, editingTicket?.content || editingTicket?.brief),
      visitDate: visitDate || null,
      contactName: contactName || null,
      address: address || null,
      userId: user.uid,
      updatedAt: serverTimestamp(),
    };

    try {
      await updateDoc(doc(db, 'tickets', editingTicket.id), data);
      setIsAddOpen(false);
      setEditingTicket(null);
      setTicketNumber('');
      setSubject('');
      setVisitDate('');
      setContactName('');
      setAddress('');
    } catch (err) {
      console.error("Save error:", err);
    }
  };

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm('Are you sure you want to delete this ticket?')) {
      await deleteDoc(doc(db, 'tickets', id));
    }
  };

  const exportToCSV = () => {
    const headers = ['Ticket Number', 'Subject', 'Status', 'Visit Date', 'Contact Name', 'Address', 'Created At'];
    const rows = tickets.map(t => [
      t.ticketNumber,
      `"${t.subject.replace(/"/g, '""')}"`,
      t.status,
      t.visitDate || 'N/A',
      t.contactName || 'N/A',
      t.address || 'N/A',
      t.createdAt?.toDate ? format(t.createdAt.toDate(), 'yyyy-MM-dd HH:mm:ss') : 'N/A'
    ]);

    const csvContent = [headers, ...rows].map(e => e.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `STS_Audit_Report_${format(new Date(), 'yyyy_MM_dd')}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleLogout = () => {
    sessionStorage.removeItem('gmail_access_token');
    localStorage.removeItem('sts_admin_level');
    localStorage.removeItem('sts_viewer');
    localStorage.removeItem('sts_pin');
    setAdminLevel(null);
    setPin('');
    setImportStatus(null);
    logout();
  };

  const [importQuery, setImportQuery] = useState('Splendid OR Ticket OR jseefenkhalil');

  const fetchEmailsForImport = async (queryOverride?: string) => {
    if (isFetchingEmails) return;
    
    // Explicit check for viewers
    if (isViewer && !user) {
      setImportStatus('Viewer mode cannot access Gmail. Please login as Admin.');
      setIsImportModalOpen(true);
      setImportMode('manual');
      return;
    }

    setIsFetchingEmails(true);
    setImportStatus('Authenticating...');
    setIsImportModalOpen(true);
    setImportMode('gmail');
    setSelectableEmails([]);
    setSelectedEmailIds(new Set());
    
    try {
      const accessToken = await getGmailToken();
      if (!accessToken) {
        setImportStatus('Please authorize Gmail access to continue.');
        setIsFetchingEmails(false);
        return;
      }
      
      const today = new Date();
      const afterDate = format(today, 'yyyy/MM/dd');
      const query = (typeof queryOverride === 'string') ? queryOverride : importQuery;
      // Filter for tickets received today
      const finalQuery = `${query} after:${afterDate}`;
      
      setImportStatus(`Searching today's emails: ${finalQuery}...`);
      
      const searchRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(finalQuery)}&maxResults=50`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      
      if (!searchRes.ok) {
        const errData = await searchRes.json();
        throw new Error(errData.error?.message || `Search failed: ${searchRes.statusText}`);
      }
      
      const searchData = await searchRes.json();

      if (!searchData.messages || searchData.messages.length === 0) {
        setImportStatus(`No new tickets found for ${afterDate}.`);
        setIsFetchingEmails(false);
        return;
      }

      const emailDetails = [];
      const existingTicketNumbers = new Set(tickets.map(t => t.ticketNumber));

      for (const msg of searchData.messages) {
        const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=minimal`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        
        if (!detailRes.ok) {
           console.error(`Failed to fetch message ${msg.id}`);
           continue; 
        }

        const detailData = await detailRes.json();
        
        const headers = detailData.payload?.headers || [];
        const subject = headers.find((h: any) => h.name.toLowerCase() === 'subject')?.value || 'No Subject';
        const date = headers.find((h: any) => h.name.toLowerCase() === 'date')?.value || '';

        // Check for duplicates by ticket number in subject or snippet
        const ticketMatch = subject.match(/Ticket#(\d+)/i) || detailData.snippet.match(/Ticket#\s*(\d+)/i);
        const ticketNum = ticketMatch ? ticketMatch[1] : null;

        if (ticketNum && existingTicketNumbers.has(ticketNum)) {
          continue; // Skip already imported
        }

        emailDetails.push({
          id: msg.id,
          subject,
          snippet: detailData.snippet,
          date: date ? new Date(date) : new Date(),
          ticketNumber: ticketNum
        });
      }

      if (emailDetails.length === 0) {
        setImportStatus("All found tickets for today are already imported.");
      } else {
        setSelectableEmails(emailDetails.sort((a, b) => b.date.getTime() - a.date.getTime()));
        setImportStatus(null);
      }
    } catch (error: any) {
      console.error(error);
      setImportStatus(error.message || 'Error fetching emails.');
    } finally {
      setIsFetchingEmails(false);
    }
  };

  const importManualContent = async () => {
    if (!manualContent.trim() || isImporting) return;
    setIsImporting(true);
    setImportStatus('Parsing content...');

    try {
      const { ticketNumber: parsedNumber, subject, status, contactName: cName, address: addr, visitDate: vDate, brief, content, htmlContent } = parseEmailHTML(manualContent, '');
      
      const ticketNumber = manualTicketNumber.trim() || parsedNumber;

      if (ticketNumber && (subject || manualContent.length > 50)) {
          const ticketSub = subject || "Manual Import - " + ticketNumber;
        const normalizedNumber = ticketNumber.trim();
        const existing = tickets.find(t => t.ticketNumber === normalizedNumber);
        
        if (!existing) {
          if (!user && !adminLevel) {
            setImportStatus('You must be logged in as Admin to import.');
            setIsImporting(false);
            return;
          }
          const finalStatus = getStatusFromSubject(ticketSub, status, content || brief);
          await addDoc(collection(db, 'tickets'), {
            ticketNumber: normalizedNumber,
            subject: ticketSub,
            status: finalStatus,
            brief: brief || '',
            content: content || '',
            htmlContent: htmlContent || '',
            visitDate: vDate || null,
            contactName: cName || '',
            address: addr || '',
            userId: user?.uid || adminLevel || 'SYSTEM',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            priority: 'Medium',
            notes: `Manually imported at ${new Date().toLocaleString()}`,
          });
          setImportStatus('Ticket imported successfully!');
        } else {
          setImportStatus(`Ticket #${normalizedNumber} already exists. Record preserved.`);
        }
      } else {
        setImportStatus('Could not find ticket number. Please enter it manually below.');
      }

      setTimeout(() => {
        setImportStatus(null);
        if (importStatus?.includes('successfully')) {
          setManualContent('');
          setManualTicketNumber('');
          setIsImportModalOpen(false);
        }
      }, 3000);
    } catch (error) {
      console.error(error);
      setImportStatus('Error parsing content.');
    } finally {
      setIsImporting(false);
    }
  };

  const importSelectedEmails = async () => {
    if (isImporting || selectedEmailIds.size === 0) return;
    setIsImporting(true);
    setImportStatus(`Importing ${selectedEmailIds.size} tickets...`);
    
    try {
      const accessToken = await getGmailToken();
      if (!accessToken) return;

      let newCount = 0;
      const idsToProcess = Array.from(selectedEmailIds);

      for (let i = 0; i < idsToProcess.length; i++) {
        const msgId = idsToProcess[i];
        setImportStatus(`Processing email ${i + 1}/${idsToProcess.length}...`);
        
        const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const detailData = await detailRes.json();

        const headers = detailData.payload.headers;
        const outerSubject = headers.find((h: any) => h.name.toLowerCase() === 'subject')?.value || '';

        let htmlContent = '';
        let innerSubject = outerSubject;

        const findAttachmentParts = (parts: any[]): any[] => {
          let results: any[] = [];
          for (const p of parts) {
            const isEml = p.filename && p.filename.toLowerCase().includes('ticket');
            const isRfc = p.mimeType === 'message/rfc822';
            const hasId = p.body && p.body.attachmentId;
            
            if (isEml || isRfc || hasId) results.push(p);
            if (p.parts) results = results.concat(findAttachmentParts(p.parts));
          }
          return results;
        };

        const attachments = findAttachmentParts(detailData.payload.parts || [detailData.payload]);
        
        if (attachments.length === 0) {
           const getBody = (parts: any[]): string => {
             for (const p of parts) {
               if (p.mimeType === 'text/html' && p.body.data) return atob(p.body.data.replace(/-/g, '+').replace(/_/g, '/'));
               if (p.parts) {
                 const b = getBody(p.parts);
                 if (b) return b;
               }
             }
             return '';
           };
           htmlContent = getBody(detailData.payload.parts || [detailData.payload]);
        }

        for (const emlPart of attachments) {
          if (emlPart.body.attachmentId) {
            const attachRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${emlPart.body.attachmentId}`, {
              headers: { Authorization: `Bearer ${accessToken}` }
            });
            const attachData = await attachRes.json();
            
            if (attachData.data) {
              const rawEml = atob(attachData.data.replace(/-/g, '+').replace(/_/g, '/'));
              const emlSubMatch = rawEml.match(/^Subject:\s*(.*)/mi);
              if (emlSubMatch) innerSubject = emlSubMatch[1].trim();

              const htmlMatch = rawEml.match(/<html[\s\S]*?<\/html>/i);
              if (htmlMatch) {
                htmlContent = htmlMatch[0];
              } else {
                const parts = rawEml.split(/Content-Type:\s*text\/html/i);
                if (parts.length > 1) {
                  const afterHtmlHeader = parts[1];
                  const boundaryMatch = afterHtmlHeader.match(/--[\w-]+/);
                  htmlContent = boundaryMatch ? afterHtmlHeader.split(boundaryMatch[0])[0] : afterHtmlHeader;
                }
              }
            }
          }
        }

        if (htmlContent) {
          const { ticketNumber: rawNum, subject, status: rawStatus, contactName: cName, address: addr, visitDate: vDate, brief, content, htmlContent: extractedHtml } = parseEmailHTML(htmlContent, innerSubject);
          const ticketNumber = rawNum.trim();
          
          if (ticketNumber && subject) {
            const existing = tickets.find(t => t.ticketNumber === ticketNumber);
            if (!existing) {
              if (!user && !adminLevel) {
                setImportStatus('Auth session expired. Please refresh.');
                setIsImporting(false);
                return;
              }
              const finalStatus = getStatusFromSubject(subject, rawStatus, content || brief);
              await addDoc(collection(db, 'tickets'), {
                ticketNumber,
                subject,
                status: finalStatus,
                brief: brief || '',
                content: content || '',
                htmlContent: extractedHtml || '',
                visitDate: vDate || null,
                contactName: cName || '',
                address: addr || '',
                userId: user?.uid || adminLevel || 'SYSTEM',
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              });
              newCount++;
            }
          }
        }
      }

      setImportStatus(`Success! Imported ${newCount} tickets.`);
      setTimeout(() => {
        setImportStatus(null);
        setIsImportModalOpen(false);
      }, 3000);
    } catch (error: any) {
      console.error(error);
      setImportStatus('Import failed.');
    } finally {
      setIsImporting(false);
    }
  };

  const toggleEmailSelection = (id: string) => {
    const newSelection = new Set(selectedEmailIds);
    if (newSelection.has(id)) newSelection.delete(id);
    else newSelection.add(id);
    setSelectedEmailIds(newSelection);
  };

  const openEdit = (ticket: Ticket) => {
    // Auto-correct status if it has changed due to intelligence updates
    const currentStatus = getStatusFromSubject(ticket.subject, undefined, ticket.brief);
    if (currentStatus !== ticket.status && currentStatus === 'Done') {
      updateDoc(doc(db, 'tickets', ticket.id), { 
        status: 'Done',
        updatedAt: serverTimestamp() 
      }).catch(console.error);
    }

    setEditingTicket(ticket);
    setTicketNumber(ticket.ticketNumber);
    setSubject(ticket.subject);
    setVisitDate(ticket.visitDate || '');
    setContactName(ticket.contactName || '');
    setAddress(ticket.address || '');
    setIsAddOpen(true);
  };

  if (authLoading) {
    return (
      <div className="h-screen w-full flex items-center justify-center bg-dash-bg">
        <Loader2 className="w-8 h-8 animate-spin text-dash-accent" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="h-screen w-full flex flex-col items-center justify-center p-6 bg-dash-bg text-dash-text">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full rounded-2xl bg-dash-card border border-dash-border shadow-2xl overflow-hidden"
        >
          <div className="bg-dash-accent p-8 text-center text-white relative">
            <div className="w-16 h-16 bg-white/10 backdrop-blur-md rounded-2xl flex items-center justify-center mx-auto mb-4 text-white font-black text-2xl shadow-2xl border border-white/20">
              STS
            </div>
            <h1 className="text-2xl font-black tracking-tighter italic">TICKET TRACKER</h1>
            <p className="text-white/60 text-[10px] mt-1 uppercase tracking-[0.3em] font-bold">Splendid Technology Services</p>
          </div>

          <div className="p-8 space-y-8">
            <div className="space-y-4">
              <div className="text-center">
                <h3 className="text-sm font-bold uppercase tracking-widest text-dash-muted mb-4">Corporate Login</h3>
                <button 
                  onClick={loginWithGoogle}
                  className="w-full py-4 px-4 rounded-xl bg-dash-accent text-white font-bold hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-3 shadow-lg shadow-dash-accent/20"
                >
                  <Mail size={18} />
                  Login with Google
                </button>
              </div>

              <div className="relative flex items-center justify-center py-2">
                <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-dash-border"></div></div>
                <span className="relative px-4 bg-dash-card text-[10px] font-bold text-dash-muted uppercase tracking-widest">OR USE PIN</span>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2 text-center">Security Access PIN</label>
                  <div className="relative">
                    <input 
                      type="password"
                      placeholder="••••"
                      maxLength={4}
                      className="w-full bg-dash-bg border border-dash-border rounded-xl px-4 py-4 text-center text-2xl tracking-[1em] font-bold focus:outline-none focus:ring-2 focus:ring-dash-accent/50 transition-all"
                      value={pin}
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, '');
                        setPin(val);
                        localStorage.setItem('sts_pin', val);
                        if (val === '7324') {
                          setAdminLevel('full');
                        } else if (val === '2026') {
                          setAdminLevel('assistant');
                        } else if (val === '1974') {
                          // Legacy pin support if needed, otherwise ignore
                          setAdminLevel('full');
                        }
                      }}
                    />
                    {pin.length === 4 && pin !== '7324' && pin !== '2026' && pin !== '1974' && (
                      <p className="text-red-500 text-[10px] font-bold text-center mt-2 uppercase animate-bounce">Access Denied</p>
                    )}
                  </div>
                </div>

                <button 
                  onClick={() => setIsGuestViewer(true)}
                  className="w-full py-3 text-[10px] font-bold uppercase tracking-widest text-dash-muted border border-dash-border rounded-xl hover:bg-dash-bg transition-all"
                >
                  Enter as Guest Viewer
                </button>
              </div>
            </div>
          </div>
          
          <div className="bg-dash-bg p-4 text-center border-t border-dash-border">
            <p className="text-[10px] text-dash-muted uppercase font-bold tracking-tighter">Authorized Personnel Only</p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-dash-bg text-dash-text font-sans flex flex-col overflow-hidden relative">
      <div className="app-frame" />
      
      {/* Thursday Banner */}
      <AnimatePresence>
        {isShowBanner && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-dash-accent px-6 py-2 flex justify-between items-center shadow-lg z-[60] shrink-0 border-b border-white/10"
          >
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-dash-gold animate-pulse"></div>
              <span className="font-semibold text-xs lg:text-sm tracking-wide text-white uppercase italic">THURSDAY VENDOR MEETING SUMMARY</span>
            </div>
            <div className="hidden lg:flex gap-6 text-[10px] font-mono">
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-dash-gold animate-pulse"></div> <strong className="text-white">OPEN:</strong> {stats.open.toString().padStart(2, '0')}</span>
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-dash-blue"></div> <strong className="text-white">IN-PROGRESS:</strong> {stats.progress.toString().padStart(2, '0')}</span>
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-dash-secondary"></div> <strong className="text-white">DONE:</strong> {stats.done.toString().padStart(2, '0')}</span>
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-white"></div> <strong className="text-white">VISITS:</strong> {stats.visits.toString().padStart(2, '0')}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Import Modal */}
      <AnimatePresence>
        {isImportModalOpen && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-dash-bg/80 backdrop-blur-sm"
              onClick={() => !isImporting && setIsImportModalOpen(false)}
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-dash-card border border-dash-border rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="p-6 border-b border-dash-border flex flex-col gap-4 bg-dash-bg/50">
                <div className="flex justify-between items-center">
                  <div>
                    <h2 className="text-xl font-black tracking-tight flex items-center gap-3 uppercase italic text-dash-accent">
                      <Mail size={24} />
                      Import Ticket
                    </h2>
                    <p className="text-[10px] text-dash-muted font-bold uppercase tracking-widest mt-1">
                      Choose a method to add a ticket record
                    </p>
                  </div>
                  <button 
                    onClick={() => setIsImportModalOpen(false)}
                    disabled={isImporting}
                    className="p-2 hover:bg-dash-bg rounded-full transition-colors text-dash-muted"
                  >
                    <X size={20} />
                  </button>
                </div>

                <div className="flex gap-1 bg-dash-bg p-1 rounded-xl border border-dash-border">
                  <button 
                    onClick={() => setImportMode('gmail')}
                    className={cn(
                      "flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-all",
                      importMode === 'gmail' ? "bg-dash-card border border-dash-border text-dash-accent" : "text-dash-muted hover:text-dash-text"
                    )}
                  >
                    Gmail Search
                  </button>
                  <button 
                    onClick={() => setImportMode('manual')}
                    className={cn(
                      "flex-1 py-2 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-all",
                      importMode === 'manual' ? "bg-dash-card border border-dash-border text-dash-accent" : "text-dash-muted hover:text-dash-text"
                    )}
                  >
                    Manual Paste
                  </button>
                </div>

                {importMode === 'gmail' && selectableEmails.length > 0 && (
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[10px] text-dash-muted font-bold uppercase tracking-widest">
                      {selectableEmails.length} Tickets Found Today
                    </span>
                    <button 
                      onClick={() => {
                        if (selectedEmailIds.size === selectableEmails.length) {
                          setSelectedEmailIds(new Set());
                        } else {
                          const allIds = new Set(selectableEmails.map(e => e.id));
                          setSelectedEmailIds(allIds);
                        }
                      }}
                      className="text-[10px] font-black uppercase tracking-widest text-dash-accent hover:underline"
                    >
                      {selectedEmailIds.size === selectableEmails.length ? 'Deselect All' : 'Select All (' + selectableEmails.length + ')'}
                    </button>
                  </div>
                )}

                {importMode === 'gmail' && (
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-dash-muted" size={14} />
                        <input 
                          type="text"
                          value={importQuery}
                          onChange={(e) => setImportQuery(e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && fetchEmailsForImport()}
                          placeholder="Search Gmail (e.g. jseefenkhalil or Ticket#)..."
                          className="w-full bg-dash-bg border border-dash-border rounded-lg pl-9 pr-10 py-2 text-xs font-medium focus:ring-1 focus:ring-dash-accent focus:border-dash-accent transition-all outline-none"
                        />
                        {importQuery && (
                          <button 
                            onClick={() => setImportQuery('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-dash-muted hover:text-dash-text transition-colors"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                      <button 
                        onClick={() => fetchEmailsForImport()}
                        className="px-4 bg-dash-accent text-white rounded-lg text-[10px] font-bold uppercase tracking-widest hover:brightness-110 transition-all shadow-lg shadow-dash-accent/10"
                      >
                        Search Today
                      </button>
                    </div>
                    {importStatus && (
                      <div className="p-2 bg-dash-bg border border-dash-border rounded-lg">
                        <p className={cn(
                          "text-[9px] font-bold uppercase tracking-tighter",
                          importStatus.toLowerCase().includes('unavailable') ? "text-red-500" : "text-dash-accent"
                        )}>
                          {importStatus}
                        </p>
                        {importStatus.toLowerCase().includes('unavailable') && (
                          <p className="mt-1 text-[8px] text-dash-muted font-medium">
                            Browsers sometimes block popups in iframes. Try clicking the "Open in New Tab" icon at the top right of this screen.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4 flex flex-col">
                {importMode === 'gmail' ? (
                  <div className="space-y-2">
                    {isFetchingEmails ? (
                      <div className="py-20 text-center">
                        <Loader2 className="w-8 h-8 animate-spin text-dash-accent mx-auto mb-4" />
                        <p className="text-sm text-dash-muted font-medium italic">Scanning your inbox...</p>
                      </div>
                    ) : selectableEmails.length === 0 ? (
                      <div className="py-20 text-center">
                        <Mail className="w-12 h-12 text-dash-border mx-auto mb-4" />
                        <p className="text-sm text-dash-muted italic">Ready to sync with Gmail.</p>
                        <p className="text-[10px] text-dash-muted uppercase font-bold tracking-widest mt-4 mb-6">
                           We search for Splendid ticket emails sent to your inbox.
                        </p>
                        <button 
                          onClick={() => fetchEmailsForImport()}
                          className="px-8 py-3 bg-dash-bg border border-dash-border rounded-xl text-xs font-bold uppercase tracking-widest hover:border-dash-accent hover:text-dash-accent transition-all"
                        >
                          Connect & Search Inbox
                        </button>
                      </div>
                    ) : (
                      selectableEmails.map((email) => (
                        <div 
                          key={email.id}
                          onClick={() => !isImporting && toggleEmailSelection(email.id)}
                          className={cn(
                            "p-4 rounded-xl border transition-all cursor-pointer flex gap-4 items-start group",
                            selectedEmailIds.has(email.id) 
                              ? "bg-dash-accent/10 border-dash-accent shadow-sm" 
                              : "bg-dash-bg/50 border-dash-border hover:border-dash-muted"
                          )}
                        >
                          <div className={cn(
                            "shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-all mt-0.5",
                            selectedEmailIds.has(email.id) 
                              ? "bg-dash-accent border-dash-accent" 
                              : "border-dash-muted group-hover:border-dash-text"
                          )}>
                            {selectedEmailIds.has(email.id) && <CheckCircle2 size={12} className="text-white" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex justify-between items-start gap-2 mb-1">
                              <h3 className={cn(
                                "text-sm font-bold truncate transition-colors",
                                selectedEmailIds.has(email.id) ? "text-dash-accent" : "text-dash-text"
                              )}>
                                {email.subject}
                              </h3>
                              <span className="text-[10px] text-dash-muted font-mono whitespace-nowrap mt-1">
                                {format(email.date, 'MMM d, p')}
                              </span>
                            </div>
                            <p className="text-[11px] text-dash-muted line-clamp-2 leading-relaxed italic">
                              {email.snippet}
                            </p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col gap-4">
                    <div className="px-2 space-y-4">
                      <p className="text-xs text-dash-muted italic">
                        Copy the entire email content from Gmail and paste it here. We'll automatically extract the details.
                      </p>
                      <div className="grid grid-cols-1 gap-1.5">
                        <label className="text-[10px] font-bold uppercase tracking-widest text-dash-muted px-1">Ticket Number (Use this if extraction fails)</label>
                        <div className="relative">
                          <input 
                            type="text"
                            value={manualTicketNumber}
                            onChange={(e) => setManualTicketNumber(e.target.value)}
                            placeholder="e.g. 92038"
                            className="w-full bg-dash-bg border border-dash-border rounded-lg px-4 py-2 text-sm font-mono focus:ring-1 focus:ring-dash-accent transition-all outline-none"
                          />
                          <ListChecks className="absolute right-3 top-1/2 -translate-y-1/2 text-dash-muted/40" size={16} />
                        </div>
                      </div>
                    </div>
                    <textarea 
                      value={manualContent}
                      onChange={(e) => setManualContent(e.target.value)}
                      placeholder="Paste email HTML or text here..."
                      className="flex-1 w-full bg-dash-bg border border-dash-border rounded-xl p-4 text-xs font-medium resize-none focus:ring-1 focus:ring-dash-accent focus:border-dash-accent transition-all outline-none min-h-[250px]"
                    />
                  </div>
                )}
              </div>

              <div className="p-6 border-t border-dash-border bg-dash-bg/50 flex flex-col gap-4">
                {importStatus && (
                  <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-widest text-dash-accent animate-pulse">
                    <Loader2 size={14} className="animate-spin" />
                    {importStatus}
                  </div>
                )}
                <div className="flex justify-between items-center">
                  {importMode === 'gmail' ? (
                    <>
                      <p className="text-xs text-dash-muted font-bold uppercase tracking-widest">
                        {selectedEmailIds.size} emails selected
                      </p>
                      <div className="flex gap-2">
                        <button 
                          onClick={() => setIsImportModalOpen(false)}
                          disabled={isImporting}
                          className="px-6 py-2.5 text-xs font-bold uppercase tracking-widest text-dash-muted hover:text-dash-text transition-colors"
                        >
                          Cancel
                        </button>
                        <button 
                          onClick={importSelectedEmails}
                          disabled={isImporting || selectedEmailIds.size === 0}
                          className="bg-dash-accent text-white px-8 py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest shadow-lg shadow-dash-accent/20 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed flex items-center gap-2"
                        >
                          {isImporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                          {isImporting ? 'Importing...' : 'Import Selected'}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div />
                      <div className="flex gap-3">
                        <button 
                          onClick={() => {
                            setManualContent('');
                            setImportMode('gmail');
                          }}
                          disabled={isImporting}
                          className="px-6 py-2.5 text-xs font-bold uppercase tracking-widest text-dash-muted hover:text-dash-text transition-colors"
                        >
                          Clear
                        </button>
                        <button 
                          onClick={importManualContent}
                          disabled={isImporting || !manualContent.trim()}
                          className="bg-dash-accent text-white px-8 py-2.5 rounded-lg text-xs font-bold uppercase tracking-widest shadow-lg shadow-dash-accent/20 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:grayscale disabled:cursor-not-allowed flex items-center gap-2"
                        >
                          {isImporting ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                          {isImporting ? 'Parsing...' : 'Parse & Import'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="hidden lg:flex w-72 bg-dash-card border-r border-dash-border p-6 flex-col gap-8 shrink-0">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 bg-dash-accent rounded flex items-center justify-center font-bold text-white shadow-lg border border-white/20">STS</div>
            <h1 className="text-lg font-black tracking-tight italic text-dash-accent uppercase">Tracker</h1>
          </div>

          <nav className="flex flex-col gap-2">
            <div className="text-[10px] text-dash-muted font-bold uppercase tracking-widest mb-1">Navigation</div>
            <button 
              onClick={() => setView('dashboard')}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-all text-left",
                view === 'dashboard' ? "bg-dash-accent text-white shadow-md shadow-dash-accent/20" : "text-dash-muted hover:bg-dash-bg"
              )}
            >
              <LayoutDashboard size={18} />
              Dashboard
            </button>
            <button 
              onClick={() => setView('activity')}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-all text-left",
                view === 'activity' ? "bg-dash-accent text-white shadow-md shadow-dash-accent/20" : "text-dash-muted hover:bg-dash-bg"
              )}
            >
              <CalendarCheck size={18} />
              Activity Board
            </button>
            <button 
              onClick={() => setView('reports')}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-all text-left",
                view === 'reports' ? "bg-dash-accent text-white shadow-md shadow-dash-accent/20" : "text-dash-muted hover:bg-dash-bg"
              )}
            >
              <FileText size={18} />
              Annual Reports
            </button>
          </nav>

          <div className="mt-4">
            <div className="text-[10px] text-dash-muted font-bold uppercase tracking-widest mb-3">System Actions</div>
            {!isAdmin && !isAssistant ? (
               <div className="px-3 py-4 bg-dash-bg border border-dash-border rounded-lg text-center">
                 <p className="text-[9px] text-dash-muted uppercase font-bold mb-3">Admin Only Features</p>
                 <button 
                  onClick={() => {
                    setAdminLevel(null);
                    logout();
                  }}
                  className="w-full py-2 bg-dash-accent text-white text-[9px] font-bold uppercase tracking-widest rounded shadow-lg shadow-dash-accent/20"
                >
                  Switch to Admin
                </button>
               </div>
            ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[9px] text-dash-muted font-bold uppercase tracking-widest">Auto-Sync</span>
                    <button 
                        onClick={() => setAutoSync(!autoSync)}
                        className={cn(
                        "w-8 h-4 rounded-full transition-all relative",
                        autoSync ? "bg-dash-accent" : "bg-dash-border"
                        )}
                    >
                        <div className={cn(
                        "absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all",
                        autoSync ? "right-0.5" : "left-0.5"
                        )} />
                    </button>
                  </div>
                  
                  <button 
                    onClick={fetchEmailsForImport}
                    disabled={isFetchingEmails || isImporting}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-dash-bg border border-dash-border hover:border-dash-accent transition-all group"
                  >
                    <Mail size={14} className={cn("text-dash-accent transition-all", isFetchingEmails && "animate-pulse")} />
                    <span>{isFetchingEmails ? 'Connecting...' : 'Sync Now'}</span>
                  </button>
                </div>
            )}
            {importStatus && !isImportModalOpen && (
              <div className="mt-2 px-2 text-[9px] font-bold text-dash-accent animate-pulse uppercase tracking-tighter">
                {importStatus}
              </div>
            )}
          </div>

          <div className="mt-4">
            <div className="text-[10px] text-dash-muted font-bold uppercase tracking-widest mb-3">Today's Schedule</div>
            <div className="space-y-3">
              {upcomingVisits.filter(v => v.visitDate && isSameDay(new Date(v.visitDate), new Date())).length === 0 ? (
                <p className="text-[10px] text-dash-muted px-2">No visits scheduled for today.</p>
              ) : (
                tickets
                  .filter(t => t.status === 'Visit Scheduled' && t.visitDate && isSameDay(new Date(t.visitDate), new Date()))
                  .map(v => (
                    <div key={v.id} className="bg-dash-accent/10 border border-dash-accent/20 p-3 rounded-lg">
                      <div className="text-[10px] text-dash-accent font-bold mb-1 uppercase">Campus Visit</div>
                      <div className="text-sm font-medium">Ticket #{v.ticketNumber}</div>
                      <div className="text-[10px] text-dash-muted mt-1 uppercase truncate">{v.subject}</div>
                    </div>
                  ))
              )}
            </div>
          </div>

          <div className="mt-auto pt-6 border-t border-dash-border">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-8 h-8 rounded-full bg-dash-bg flex items-center justify-center overflow-hidden border border-dash-border">
                  {isAdmin && user?.photoURL ? <img src={user.photoURL} alt="" /> : <div className="text-xs uppercase font-bold text-dash-accent">{isViewer ? 'V' : (user?.email?.[0] || 'U')}</div>}
                </div>
                <div className="flex-1 overflow-hidden">
                  <p className="text-xs font-bold truncate text-dash-text">{isAdmin ? (user?.displayName || 'Admin') : 'Restricted Access'}</p>
                  <p className="text-[10px] text-dash-muted truncate">{isAdmin ? user?.email : 'Viewer Mode'}</p>
                </div>
              </div>
              <button 
                onClick={() => isAdmin ? handleLogout() : setIsGuestViewer(false)}
                className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-dash-muted hover:text-dash-accent transition-colors"
              >
                <LogOut size={14} />
                {isAdmin ? 'Terminate Session' : 'Exit Viewer'}
              </button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col overflow-hidden min-w-0">
          <div className="flex-1 overflow-y-auto p-4 lg:p-8 scrollbar-dash">
            {view === 'dashboard' ? (
              <div className="flex gap-8 h-full">
                <div className="flex-1 flex flex-col gap-6">
                  {/* Top Stats */}
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                    <button 
                      onClick={() => setStatusFilter('All')}
                      className={cn(
                        "bg-dash-card p-4 border rounded-xl shadow-sm transition-all text-left group",
                        statusFilter === 'All' ? "border-dash-accent ring-1 ring-dash-accent bg-dash-accent/5" : "border-dash-border hover:border-dash-accent"
                      )}
                    >
                      <div className="text-[10px] text-dash-muted font-bold uppercase tracking-widest mb-1 group-hover:text-dash-text transition-colors">Total Managed</div>
                      <div className="text-2xl font-bold">{stats.total}</div>
                    </button>
                    <button 
                      onClick={() => setStatusFilter('Open')}
                      className={cn(
                        "bg-dash-card p-4 border rounded-xl shadow-sm transition-all text-left group",
                        statusFilter === 'Open' ? "border-red-500 ring-2 ring-red-500/20 bg-red-500/10" : "border-dash-border hover:border-red-400"
                      )}
                    >
                      <div className="text-[10px] font-bold uppercase tracking-widest mb-1 text-red-600">Critical Open</div>
                      <div className="text-2xl font-bold text-red-600">{stats.open.toString().padStart(2, '0')}</div>
                    </button>
                    <button 
                      onClick={() => setStatusFilter('In Progress')}
                      className={cn(
                        "bg-dash-card p-4 border rounded-xl shadow-sm transition-all text-left group",
                        statusFilter === 'In Progress' ? "border-amber-500 ring-2 ring-amber-500/20 bg-amber-500/10" : "border-dash-border hover:border-amber-400"
                      )}
                    >
                      <div className="text-[10px] font-bold uppercase tracking-widest mb-1 text-amber-600">In Transit</div>
                      <div className="text-2xl font-bold text-amber-600">{stats.progress.toString().padStart(2, '0')}</div>
                    </button>
                    <button 
                      onClick={() => setStatusFilter('Resolved')}
                      className={cn(
                        "bg-dash-card p-4 border rounded-xl shadow-sm transition-all text-left group",
                        statusFilter === 'Resolved' ? "border-green-500 ring-2 ring-green-500/20 bg-green-500/10" : "border-dash-border hover:border-green-400"
                      )}
                    >
                      <div className="text-[10px] font-bold uppercase tracking-widest mb-1 text-green-600">Resolved</div>
                      <div className="text-2xl font-bold text-green-600">{stats.done.toString().padStart(2, '0')}</div>
                    </button>
                  </div>

                  {/* Header/Controls */}
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <h1 className="text-2xl font-black italic tracking-tighter uppercase flex items-center gap-2">
                       <LayoutDashboard className="text-dash-accent" />
                       Operations
                    </h1>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2 bg-dash-card border border-dash-border px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest text-dash-muted">
                        <span>Hide Completed</span>
                        <button 
                          onClick={() => setHideCompleted(!hideCompleted)}
                          className={cn(
                            "w-6 h-3 rounded-full transition-all relative",
                            hideCompleted ? "bg-dash-accent" : "bg-dash-border"
                          )}
                        >
                          <div className={cn(
                            "absolute top-0.5 w-2 h-2 bg-white rounded-full transition-all",
                            hideCompleted ? "right-0.5" : "left-0.5"
                          )} />
                        </button>
                      </div>
                      <div className="relative group w-full lg:w-72">
                        <Search size={14} className="absolute left-3 top-2.5 text-dash-muted group-focus-within:text-dash-accent transition-colors" />
                        <input 
                          type="text" 
                          placeholder="Search identifier..." 
                          className="bg-dash-card border border-dash-border text-xs rounded-xl px-10 py-2.5 w-full focus:outline-none focus:border-dash-accent transition-all"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </div>
                      <button 
                        onClick={() => {
                          setEditingTicket(null);
                          setTicketNumber('');
                          setSubject('');
                          setVisitDate('');
                          setContactName('');
                          setAddress('');
                          setIsAddOpen(true);
                        }}
                        className="bg-dash-accent text-white h-10 px-4 rounded-xl shadow-lg shadow-dash-accent/20 flex items-center gap-2 hover:brightness-110 transition-all font-bold text-[10px] uppercase tracking-widest"
                      >
                        <Plus size={16} />
                        Manual
                      </button>
                    </div>
                  </div>

                  {/* Table/List */}
                  <div className="bg-dash-card border border-dash-border rounded-3xl flex-1 flex flex-col overflow-hidden min-h-[400px]">
                    <div className="overflow-x-auto h-full">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="text-[10px] text-dash-muted uppercase tracking-[0.2em] border-b border-dash-border bg-dash-card/50">
                            <th className="px-6 py-5 font-black">Ref</th>
                            <th className="px-6 py-5 font-black">Context</th>
                            <th className="px-6 py-5 font-black">Status</th>
                            <th className="px-6 py-5 font-black text-right">Modified</th>
                          </tr>
                        </thead>
                        <tbody className="text-xs divide-y divide-dash-border">
                          {ticketsLoading ? (
                            <tr>
                              <td colSpan={4} className="px-6 py-20 text-center">
                                <Loader2 className="w-8 h-8 animate-spin text-dash-accent mx-auto" />
                              </td>
                            </tr>
                          ) : filteredTickets.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="px-6 py-40 text-center text-dash-muted italic font-medium">
                                No active payloads in current segment.
                              </td>
                            </tr>
                          ) : (
                            filteredTickets.map((t) => (
                              <tr 
                                key={t.id} 
                                onClick={() => openEdit(t)}
                                className={cn(
                                  "hover:bg-dash-accent/5 transition-all cursor-pointer group",
                                  t.status.toLowerCase().includes('visit') && isSameDay(new Date(t.visitDate!), new Date()) && "bg-dash-accent/10 border-l-4 border-l-dash-accent"
                                )}
                              >
                                <td className="px-6 py-6 font-mono font-bold text-dash-muted group-hover:text-dash-text">
                                  #{t.ticketNumber}
                                </td>
                                <td className="px-6 py-6">
                                  <div className="flex flex-col gap-1">
                                    <span className="text-dash-text font-bold text-sm tracking-tight">{t.subject}</span>
                                    <div className="flex items-center gap-3">
                                       {t.visitDate && <span className="text-[10px] text-dash-accent font-black uppercase bg-dash-accent/10 px-1.5 rounded">{t.visitDate}</span>}
                                       {t.contactName && <span className="text-[10px] text-dash-muted font-bold uppercase truncate max-w-[150px]">{t.contactName}</span>}
                                    </div>
                                  </div>
                                </td>
                                <td className="px-6 py-6">
                                  <StatusBadge status={t.status} />
                                </td>
                                <td className="px-6 py-6 text-right">
                                   <div className="flex items-center justify-end gap-4">
                                      <span className="text-[10px] text-dash-muted font-bold">{t.updatedAt?.toDate ? format(t.updatedAt.toDate(), 'HH:mm') : '-'}</span>
                                      {canAccessFullAdmin && (
                                        <button 
                                          onClick={(e) => handleDelete(t.id, e)}
                                          className="p-1.5 hover:bg-red-500/10 text-dash-muted hover:text-red-500 rounded transition-all"
                                          title="Delete Permanently"
                                        >
                                          <Trash2 size={14} />
                                        </button>
                                      )}
                                      <ChevronRight size={16} className="text-dash-border group-hover:text-dash-accent transition-all" />
                                   </div>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                {/* Scheduled Side Panel */}
                <div className="hidden xl:flex flex-col w-80 shrink-0 gap-6">
                   <div className="bg-dash-card border border-dash-border rounded-3xl overflow-hidden flex flex-col h-full shadow-2xl">
                      <div className="p-6 bg-dash-accent text-white bg-gradient-to-br from-dash-accent to-[#7a1827]">
                         <h2 className="text-xl font-black italic tracking-tighter uppercase leading-none">Schedule</h2>
                         <p className="text-[9px] font-bold uppercase tracking-widest opacity-60 mt-1">Pending Field Visits</p>
                      </div>
                      <div className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-dash">
                         {upcomingVisits.length === 0 ? (
                           <div className="h-40 flex flex-col items-center justify-center opacity-30 text-center">
                              <Calendar size={32} className="mb-2" />
                              <p className="text-[9px] font-bold uppercase tracking-widest">No dates pending</p>
                           </div>
                         ) : (
                            upcomingVisits.map(v => (
                              <div key={v.id} onClick={() => openEdit(v)} className="bg-dash-bg/50 border border-dash-border p-4 rounded-2xl hover:border-dash-accent transition-all cursor-pointer group">
                                 <div className="flex justify-between items-center mb-2">
                                    <span className="text-[10px] font-mono font-bold text-dash-accent italic">#{v.ticketNumber}</span>
                                    <span className="text-[9px] font-black uppercase text-dash-muted">{v.visitDate}</span>
                                 </div>
                                 <h4 className="text-[11px] font-bold text-dash-text line-clamp-2 leading-tight uppercase group-hover:text-dash-accent transition-colors">{v.subject}</h4>
                              </div>
                            ))
                         )}
                      </div>
                   </div>
                   
                   <div className="bg-dash-card border border-dash-border rounded-3xl p-6 flex flex-col gap-4">
                      <h3 className="text-[10px] font-black uppercase tracking-widest text-dash-muted">Operational Health</h3>
                      <div className="flex items-center gap-3">
                         <div className="w-1.5 h-1.5 rounded-full bg-dash-secondary animate-pulse" />
                         <span className="text-[11px] font-bold text-dash-text">All systems nominal</span>
                      </div>
                      <div className="w-full bg-dash-border h-1 rounded-full overflow-hidden">
                         <div className="bg-dash-accent w-[85%] h-full rounded-full" />
                      </div>
                   </div>
                </div>
              </div>
            ) : view === 'activity' ? (
              <div className="flex flex-col gap-8 max-w-6xl mx-auto w-full">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 uppercase italic">
                      <CalendarCheck className="text-dash-accent" />
                      Operational Board
                    </h2>
                    <p className="text-dash-muted text-[10px] font-bold uppercase tracking-[0.2em] mt-1">
                      {format(selectedWeek.start, 'MMM d')} - {format(selectedWeek.end, 'MMM d, yyyy')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 bg-dash-card border border-dash-border p-1 rounded-xl shadow-sm">
                    <button onClick={() => setWeekOffset(v => v - 1)} className="p-2 hover:bg-dash-bg rounded-lg transition-all text-dash-muted">
                      <ChevronRight size={18} className="rotate-180" />
                    </button>
                    <button onClick={() => setWeekOffset(0)} className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest hover:text-dash-accent transition-colors border-x border-dash-border">Today</button>
                    <button onClick={() => setWeekOffset(v => v + 1)} className="p-2 hover:bg-dash-bg rounded-lg transition-all text-dash-muted">
                      <ChevronRight size={18} />
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {/* Scheduled Future */}
                  <div className="flex flex-col gap-5">
                    <div className="flex items-center gap-2 text-dash-accent">
                      <Calendar size={18} />
                      <h3 className="text-xs font-black uppercase tracking-widest italic">Upcoming Visits</h3>
                      <span className="ml-auto text-[10px] font-bold py-1 px-3 bg-dash-accent/10 border border-dash-accent/20 rounded-full">{activityGroups.scheduled.length}</span>
                    </div>
                    <div className="space-y-4">
                      {activityGroups.scheduled.map(t => (
                        <div key={t.id} className="bg-dash-card border border-dash-accent/20 p-5 rounded-2xl shadow-sm hover:shadow-lg transition-all border-l-4 border-l-dash-accent cursor-pointer group" onClick={() => openEdit(t)}>
                          <div className="flex justify-between items-start mb-3">
                            <span className="text-[10px] font-mono text-dash-accent font-black uppercase">{t.visitDate}</span>
                            <span className="text-[9px] font-bold text-dash-muted uppercase">#{t.ticketNumber}</span>
                          </div>
                          <div className="font-bold text-sm leading-tight group-hover:text-dash-accent transition-colors mb-2 uppercase italic">{t.subject}</div>
                          <div className="text-[10px] text-dash-muted font-medium truncate italic">{t.address || 'No location provided'}</div>
                        </div>
                      ))}
                      {activityGroups.scheduled.length === 0 && <p className="text-[10px] text-dash-muted italic text-center py-10">No upcoming visits scheduled.</p>}
                    </div>
                  </div>
   
                  {/* Completed */}
                  <div className="flex flex-col gap-5">
                    <div className="flex items-center gap-2 text-dash-secondary">
                      <CheckCircle2 size={18} />
                      <h3 className="text-xs font-black uppercase tracking-widest italic">Resolved</h3>
                      <span className="ml-auto text-[10px] font-bold py-1 px-3 bg-dash-secondary/10 border border-dash-secondary/20 rounded-full">{activityGroups.completed.length}</span>
                    </div>
                    <div className="space-y-4">
                      {activityGroups.completed.map(t => (
                        <div key={t.id} className="bg-dash-card border border-dash-border p-5 rounded-2xl shadow-sm hover:shadow-md transition-all cursor-pointer group" onClick={() => openEdit(t)}>
                          <div className="text-[10px] font-mono text-dash-muted mb-2 font-bold uppercase tracking-tighter">Reference #{t.ticketNumber}</div>
                          <div className="font-bold text-sm leading-tight mb-3 group-hover:text-dash-secondary transition-colors italic">{t.subject}</div>
                          <div className="flex items-center gap-2 text-dash-secondary text-[10px] font-black uppercase">
                             <div className="w-1.5 h-1.5 rounded-full bg-dash-secondary" />
                             Marked Complete
                          </div>
                        </div>
                      ))}
                      {activityGroups.completed.length === 0 && <p className="text-[10px] text-dash-muted italic text-center py-10">Historical records cleared.</p>}
                    </div>
                  </div>
   
                  {/* Waiting */}
                  <div className="flex flex-col gap-5">
                    <div className="flex items-center gap-2 text-dash-gold">
                      <Clock size={18} />
                      <h3 className="text-xs font-black uppercase tracking-widest italic">Active Queue</h3>
                      <span className="ml-auto text-[10px] font-bold py-1 px-3 bg-dash-gold/10 border border-dash-gold/20 rounded-full">{activityGroups.waiting.length}</span>
                    </div>
                    <div className="space-y-4">
                      {activityGroups.waiting.map(t => (
                        <div key={t.id} className="bg-dash-card border border-dash-border p-5 rounded-2xl shadow-sm hover:shadow-md transition-all cursor-pointer group" onClick={() => openEdit(t)}>
                          <div className="text-[10px] font-mono text-dash-muted mb-2 font-bold uppercase">Ticket #{t.ticketNumber}</div>
                          <div className="font-bold text-sm leading-tight mb-3 group-hover:text-dash-gold transition-colors">{t.subject}</div>
                          <div className="flex items-center gap-2">
                             <div className="w-1.5 h-1.5 rounded-full bg-dash-gold animate-pulse"></div>
                             <span className="text-[9px] text-dash-gold font-black uppercase tracking-tight">Requires Attention</span>
                          </div>
                        </div>
                      ))}
                      {activityGroups.waiting.length === 0 && <p className="text-[10px] text-dash-muted italic text-center py-10">Queue currently clear.</p>}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
                <div className="flex flex-col gap-10 max-w-4xl mx-auto w-full">
                  <div>
                    <h2 className="text-2xl font-black tracking-tight flex items-center gap-3 uppercase italic">
                      <FileText className="text-dash-accent" />
                      Annual Reporting
                    </h2>
                    <p className="text-dash-muted text-[10px] font-bold uppercase tracking-widest mt-1">
                      Data Export Hub for Audit Readiness.
                    </p>
                  </div>
    
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="bg-dash-card border border-dash-border p-8 rounded-3xl shadow-sm space-y-6">
                      <div className="w-12 h-12 bg-dash-accent/10 rounded-2xl flex items-center justify-center text-dash-accent">
                        <Download size={24} />
                      </div>
                      <div>
                        <h3 className="font-bold text-lg mb-1 italic uppercase tracking-tighter">CSV Performance Export</h3>
                        <p className="text-xs text-dash-muted leading-relaxed">
                          Export all ticket records, including site addresses and site contacts. 
                          Data is filtered for the active operational period.
                        </p>
                      </div>
                      <button 
                        onClick={exportToCSV}
                        className="w-full py-4 bg-dash-accent text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:brightness-110 transition-all shadow-lg shadow-dash-accent/20 flex items-center justify-center gap-3"
                      >
                        <Download size={16} />
                        Execute Download
                      </button>
                    </div>
    
                    <div className="bg-dash-card border border-dash-border p-8 rounded-3xl shadow-sm space-y-6">
                      <div className="w-12 h-12 bg-dash-gold/10 rounded-2xl flex items-center justify-center text-dash-gold">
                        <Mail size={24} />
                      </div>
                      <div>
                        <h3 className="font-bold text-lg mb-1 italic uppercase tracking-tighter">Service Log Sync</h3>
                        <p className="text-xs text-dash-muted leading-relaxed">
                          Synchronize with the Splendid Technology service account.
                          Duplicates are automatically filtered during the handshake.
                        </p>
                      </div>
                      <button 
                        onClick={fetchEmailsForImport}
                        disabled={isFetchingEmails || isImporting}
                        className="w-full py-4 bg-dash-accent text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:brightness-110 transition-all shadow-lg shadow-dash-accent/20 flex items-center justify-center gap-3 disabled:opacity-50"
                      >
                        <Mail size={16} className={isFetchingEmails ? "animate-pulse" : ""} />
                        {isFetchingEmails ? 'Initializing Sync...' : 'Sync Mailbox Logs'}
                      </button>
                    </div>
                  </div>
    
                  <div className="bg-dash-card border border-dash-border p-8 rounded-3xl">
                     <div className="flex items-center gap-3 mb-4 text-dash-muted">
                       <AlertCircle size={18} />
                       <h4 className="text-[10px] font-black uppercase tracking-widest">Compliance Notice</h4>
                     </div>
                     <p className="text-[10px] text-dash-muted leading-relaxed uppercase font-bold tracking-tighter opacity-50">
                       All data remains permanent across reset operations unless a Factory Wipe is initiated by a Full Admin. 
                       Audit reports are generated in real-time from the Firestore high-availability cluster.
                     </p>
                  </div>
                </div>
            )}
          </div>
        </main>
      </div>

      {/* Slide Modal */}
      <AnimatePresence>
        {isAddOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsAddOpen(false)}
              className="fixed inset-0 bg-dash-bg/80 backdrop-blur-sm z-50 px-4"
            />
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 h-screen w-full lg:w-[480px] bg-dash-card border-l border-dash-border z-50 shadow-2xl p-8 overflow-y-auto"
            >
              <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-3">
                   <div className="w-8 h-8 bg-dash-accent rounded flex items-center justify-center font-bold text-white text-sm">ST</div>
                   <h2 className="text-xl font-bold tracking-tight">Ticket Analyst</h2>
                </div>
                <button onClick={() => setIsAddOpen(false)} className="p-2 bg-dash-border rounded hover:bg-dash-muted transition-colors text-dash-text">
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-6">
                <div>
                   <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Live Status</label>
                   <StatusBadge status={getStatusFromSubject(subject, undefined, editingTicket?.content || editingTicket?.brief)} />
                </div>

                {editingTicket?.brief && (
                  <div className="p-5 rounded-2xl bg-dash-accent/5 border border-dash-accent/10 relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-1 h-full bg-dash-accent" />
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-accent mb-3">Intelligence Summary</label>
                    <p className="text-sm leading-relaxed text-dash-text italic font-medium">"{editingTicket.brief}"</p>
                  </div>
                )}

                {editingTicket?.content && !editingTicket?.htmlContent && (
                  <div className="space-y-2">
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Intelligence Log Content</label>
                    <div className="w-full bg-dash-bg border border-dash-border rounded-xl p-5 overflow-y-auto max-h-[300px] text-xs leading-relaxed text-dash-muted font-mono whitespace-pre-wrap">
                      {editingTicket.content}
                    </div>
                  </div>
                )}

                {editingTicket?.htmlContent && (
                  <div className="space-y-2">
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Original Email Record</label>
                    <div 
                      className="w-full bg-white border border-dash-border rounded-xl overflow-hidden overflow-y-auto max-h-[500px]"
                      style={{ color: 'initial' }}
                    >
                      <div className="p-4 transform scale-[0.9] origin-top-left" dangerouslySetInnerHTML={{ __html: editingTicket.htmlContent }} />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Record Identifier</label>
                  <div 
                    className="w-full bg-dash-bg border border-dash-border rounded px-4 py-3 font-mono text-sm opacity-70"
                  >
                    #{ticketNumber}
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Subject Context</label>
                  <div 
                    className="w-full bg-dash-bg border border-dash-border rounded px-4 py-3 text-sm leading-relaxed min-h-[80px]"
                  >
                    {subject}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Campus Address</label>
                    <input 
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      placeholder="N/A"
                      className="w-full bg-dash-bg border border-dash-border rounded px-4 py-3 text-sm focus:outline-none focus:border-dash-accent transition-all"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Visit Estimate</label>
                    <input 
                      value={visitDate}
                      onChange={(e) => setVisitDate(e.target.value)}
                      placeholder="No schedule detected"
                      className="w-full bg-dash-bg border border-dash-border rounded px-4 py-3 text-sm focus:outline-none focus:border-dash-accent transition-all"
                    />
                  </div>
                </div>

                <div className="pt-10 space-y-4">
                  {editingTicket && (
                    <button 
                      type="button"
                      onClick={async () => {
                        const data = {
                          ticketNumber,
                          subject,
                          status: getStatusFromSubject(subject, undefined, editingTicket?.content || editingTicket?.brief),
                          visitDate: visitDate || null,
                          address: address || null,
                          updatedAt: serverTimestamp()
                        };
                        await updateDoc(doc(db, 'tickets', editingTicket.id), data);
                        setIsAddOpen(false);
                      }}
                      className="w-full bg-dash-accent text-white py-4 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:brightness-110 shadow-lg shadow-dash-accent/20 transition-all"
                    >
                      Commit Record Changes
                    </button>
                  )}

                  {editingTicket && canAccessFullAdmin && (
                    <button 
                      type="button"
                      onClick={async () => {
                        if (confirm('Permanently delete this ticket record?')) {
                          await deleteDoc(doc(db, 'tickets', editingTicket.id));
                          setIsAddOpen(false);
                        }
                      }}
                      className="w-full bg-red-600/10 border border-red-500/20 text-red-500 py-4 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:bg-red-600 hover:text-white transition-all flex items-center justify-center gap-2"
                    >
                      <Trash2 size={14} />
                      Delete Ticket Permanently
                    </button>
                  )}

                  {editingTicket && (getStatusFromSubject(subject).toLowerCase().includes('done') || getStatusFromSubject(subject).toLowerCase().includes('complete') || getStatusFromSubject(subject).toLowerCase().includes('resolve')) && (
                    <button 
                      type="button"
                      onClick={async () => {
                        if (editingTicket) {
                          await updateDoc(doc(db, 'tickets', editingTicket.id), { archived: true });
                          setIsAddOpen(false);
                        }
                      }}
                      className="w-full bg-dash-bg border border-dash-border py-4 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:border-dash-secondary/30 transition-all flex items-center justify-center gap-2 group"
                    >
                      <CheckCircle2 size={14} className="text-dash-secondary" />
                      Archive Closed Ticket
                    </button>
                  )}
                  
                  <button 
                    type="button"
                    onClick={() => setIsAddOpen(false)}
                    className="w-full py-4 text-[10px] font-black uppercase tracking-[0.2em] text-dash-muted hover:text-dash-text transition-all bg-dash-bg rounded-xl border border-dash-border"
                  >
                    Close Analysis
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
