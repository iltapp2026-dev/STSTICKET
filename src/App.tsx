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
  Activity,
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
  softDeleteTickets,
  Ticket, 
  db,
  auth,
  arrayUnion,
  extractVisitDate,
  handleFirestoreError,
  OperationType
} from './lib/firebase';
import { collection, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, writeBatch, getDocFromServer } from 'firebase/firestore';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const isDone = s === 'done' || s === 'complete' || s === 'resolved';
  const isScheduled = s === 'scheduled';
  const isWaitingParts = s.includes('parts');
  const isWaitingInvoice = s.includes('invoice');
  const isWaiting = s.includes('waiting') && !isWaitingParts && !isWaitingInvoice;
  
  let bgColor = 'bg-red-500';
  let textColor = 'text-white';
  let borderColor = 'border-red-400';
  let animateClass = 'animate-[pulse_1.5s_infinite] ring-4 ring-red-500/40';
  
  if (isDone) {
    bgColor = 'bg-emerald-500';
    borderColor = 'border-emerald-400';
    animateClass = ''; 
  } else if (isScheduled) {
    bgColor = 'bg-blue-500';
    textColor = 'text-white';
    borderColor = 'border-blue-400';
    animateClass = 'ring-2 ring-blue-500/30 font-black'; 
  } else if (isWaitingInvoice || isWaiting) {
    bgColor = 'bg-amber-500';
    textColor = 'text-white';
    borderColor = 'border-amber-400';
    animateClass = 'animate-pulse';
  } else if (isWaitingParts) {
    bgColor = 'bg-orange-500';
    textColor = 'text-white';
    borderColor = 'border-orange-400';
    animateClass = 'animate-pulse';
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
  const [pin, setPin] = useState(() => localStorage.getItem('sts_pin') || '');
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [adminLevel, setAdminLevel] = useState<'full' | null>(() => {
    const saved = localStorage.getItem('sts_admin_level');
    return saved === 'full' ? saved : null;
  });
  const [loginMode, setLoginMode] = useState<'admin'>('admin');
  const [autoSync, setAutoSync] = useState(false);
  
  const [hideCompleted, setHideCompleted] = useState(false);
  
  const isAdmin = adminLevel === 'full';
  const isAssistant = false;
  const isViewer = !isAdmin;
  const isAuthenticated = !!adminLevel;
  const isOwnerEmail = false; 
  const canAccessFullAdmin = adminLevel === 'full';
  const canAccessAdmin = !!adminLevel;

  useEffect(() => {
    if (adminLevel) localStorage.setItem('sts_admin_level', adminLevel);
    else localStorage.removeItem('sts_admin_level');
  }, [adminLevel]);

  // If admin, they see their own (or all if we want shared). 
  // User says "my team can access it", so let's make it shared.
  const activeUserId = 'ALL';
  
  const { tickets, loading: ticketsLoading } = useTickets(activeUserId);

  useEffect(() => {
    // CRITICAL: Test connection on boot as per guidelines
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'tickets', 'connection-test'));
      } catch (error: any) {
        if (error.message && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();
  }, []);

  const todayVisits = useMemo(() => {
    const today = new Date();
    const todayY = today.getFullYear();
    const todayM = today.getMonth() + 1;
    const todayD = today.getDate();
    const todayStr = `${todayY}-${String(todayM).padStart(2, '0')}-${String(todayD).padStart(2, '0')}`;
    
    return tickets.filter(t => {
      if (t.status !== 'Scheduled' || !t.visitDate) return false;
      
      const vDateStr = String(t.visitDate);
      if (vDateStr.toLowerCase().includes('today')) return true;

      // Handle YYYY-MM-DD (standard for input type="date")
      if (vDateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        return vDateStr === todayStr;
      }

      // Handle MM/DD/YYYY
      if (vDateStr.match(/^\d{1,2}\/\d{1,2}\/\d{4}$/)) {
        const [m, d, y] = vDateStr.split('/');
        const normalized = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        return normalized === todayStr;
      }

      try {
        // Fallback for objects or other string formats, but be careful of UTC shift
        // If it's a date object, we use local components
        const vDate = new Date(t.visitDate);
        if (isNaN(vDate.getTime())) return false;
        
        // If the date string was YYYY-MM-DD, a Date object shift might have happened.
        // We already handled YYYY-MM-DD strings above, so this fallback is for other cases.
        const vy = vDate.getFullYear();
        const vm = vDate.getMonth() + 1;
        const vd = vDate.getDate();
        const normalized = `${vy}-${String(vm).padStart(2, '0')}-${String(vd).padStart(2, '0')}`;
        return normalized === todayStr;
      } catch (e) {
        return false;
      }
    });
  }, [tickets]);

  const showTodayBanner = todayVisits.length > 0;

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<Ticket['status'] | 'All'>('All');
  const [view, setView] = useState<'dashboard' | 'activity' | 'reports'>('dashboard');
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingTicket = tickets.find(t => t.id === editingId) || null;
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [isManualSaving, setIsManualSaving] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  const [showHistory, setShowHistory] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);

  // Deduping logic for UI: takes the most recently updated ticket for each ticket number
  const dedupedTickets = useMemo(() => {
    const map = new Map<string, Ticket>();
    // Sort tickets by updatedAt descending so first one seen is newest
    const sorted = [...tickets].sort((a, b) => {
      const ta = a.updatedAt?.toDate()?.getTime() || 0;
      const tb = b.updatedAt?.toDate()?.getTime() || 0;
      return tb - ta;
    });

    sorted.forEach(t => {
      if (!t.ticketNumber) return;
      const key = t.ticketNumber.replace(/\D/g, '');
      if (key && !map.has(key)) {
        map.set(key, t);
      }
    });

    return Array.from(map.values());
  }, [tickets]);

  // Filtered sets for clearing/display
  const activeTickets = useMemo(() => {
    return dedupedTickets.filter(t => !t.deletedAt && t.status !== 'Done' && t.status !== 'Complete');
  }, [dedupedTickets]);

  const historyTickets = useMemo(() => {
    return tickets.filter(t => !!t.deletedAt || t.archived);
  }, [tickets]);

  const currentTickets = useMemo(() => showHistory ? historyTickets : activeTickets, [activeTickets, historyTickets, showHistory]);

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
    const weekTickets = currentTickets.filter(t => {
      if (t.archived) return false;
      const date = t.updatedAt?.toDate ? t.updatedAt.toDate() : new Date();
      return isWithinInterval(date, selectedWeek);
    });

    return {
      completed: weekTickets.filter(t => t.status === 'Done'),
      scheduled: currentTickets.filter(t => t.status === 'Scheduled' && !t.archived),
      open: currentTickets.filter(t => t.status === 'Open' && !t.archived),
      updated: weekTickets.sort((a, b) => {
        const da = a.updatedAt?.toDate ? a.updatedAt.toDate().getTime() : 0;
        const db = b.updatedAt?.toDate ? b.updatedAt.toDate().getTime() : 0;
        return db - da;
      }).slice(0, 10)
    };
  }, [currentTickets, selectedWeek]);

  // Form state
  const [ticketNumber, setTicketNumber] = useState('');
  const [subject, setSubject] = useState('');
  const [visitDate, setVisitDate] = useState('');
  const [contactName, setContactName] = useState('');
  const [address, setAddress] = useState('');

  const filteredTickets = useMemo(() => {
    return currentTickets.filter(t => {
      const matchesSearch = t.ticketNumber.toLowerCase().includes(search.toLowerCase()) || 
                            t.subject.toLowerCase().includes(search.toLowerCase());
      
      const isDone = t.status === 'Done';
      const matchesStatus = statusFilter === 'All' || statusFilter === t.status;
      
      const notArchived = !t.archived;
      const hideCompletedFilter = !hideCompleted || !isDone;
      
      return matchesSearch && matchesStatus && notArchived && hideCompletedFilter;
    });
  }, [currentTickets, search, statusFilter, hideCompleted]);

  useEffect(() => {
    // 1. Background auto-corrector for statuses
    // 2. Background deduplication/merging for duplicates in DB
    if (tickets.length > 0) {
      // Find all ticket groups with same number (normalized)
      const groups = new Map<string, Ticket[]>();
      tickets.forEach(t => {
        if (!t.ticketNumber) return;
        const key = t.ticketNumber.replace(/\D/g, '');
        if (!key) return;
        const list = groups.get(key) || [];
        list.push(t);
        groups.set(key, list);
      });

      tickets.forEach(async (ticket) => {
        if (ticket.archived) return;
        if (ticket.manualStatusOverride) return;
        
        // AUTO-CORRECT STATUS & VISIT DATE
        // Only auto-correct if it's not a terminal state like Done
        if (ticket.status === 'Done') return;

        const bodyToScan = (ticket.brief || '') + ' ' + (ticket.content || '');
        const intelligentStatus = getStatusFromSubject('', undefined, bodyToScan);
        const extractedDate = extractVisitDate(bodyToScan);
        
        const needsStatusUpdate = intelligentStatus !== ticket.status && ticket.status === 'Open';
        const needsDateUpdate = extractedDate && !ticket.visitDate;

        if (needsStatusUpdate || needsDateUpdate) {
          try {
            await updateDoc(doc(db, 'tickets', ticket.id), {
              status: needsStatusUpdate ? intelligentStatus : ticket.status,
              ...(needsDateUpdate ? { visitDate: extractedDate } : {}),
              updatedAt: serverTimestamp()
            });
          } catch (err) {
            handleFirestoreError(err, OperationType.UPDATE, `tickets/${ticket.id}`);
          }
        }

        // B. AUTO-MERGE DUPLICATES (If more than one doc exists for this number)
        const normalizedKey = ticket.ticketNumber.replace(/\D/g, '');
        const group = normalizedKey ? groups.get(normalizedKey) : null;
        if (group && group.length > 1) {
          // Sort by updatedAt descending
          const sortedGroup = [...group].sort((a, b) => {
            const ta = a.updatedAt?.toDate()?.getTime() || 0;
            const tb = b.updatedAt?.toDate()?.getTime() || 0;
            return tb - ta;
          });

          const master = sortedGroup[0];
          const duplicates = sortedGroup.slice(1);

          for (const duplicate of duplicates) {
            console.log(`Merging duplicate #${duplicate.ticketNumber} (${duplicate.id}) into master (${master.id})`);
            // Delete the older duplicate
            await deleteDoc(doc(db, 'tickets', duplicate.id)).catch(err => console.error("Merge delete failed:", err));
          }
        }
      });
    }
  }, [tickets]); // Run when tickets update

  const stats = useMemo(() => {
    const counts = { total: 0, open: 0, scheduled: 0, done: 0, w_parts: 0, w_invoice: 0 };
    currentTickets.forEach(t => {
      if (t.archived || t.deletedAt) return;
      counts.total++;
      
      const s = t.status;
      if (s === 'Done') counts.done++;
      else if (s === 'Scheduled') counts.scheduled++;
      else if (s === 'Open') counts.open++;
      else if (s === 'Waiting for Parts') counts.w_parts++;
      else if (s === 'Waiting for Invoice') counts.w_invoice++;
    });
    return counts;
  }, [currentTickets]);

  const upcomingVisits = useMemo(() => {
    const today = startOfDay(new Date());
    return currentTickets
      .filter(t => t.status === 'Scheduled' && t.visitDate)
      .filter(t => {
        const d = new Date(t.visitDate!);
        return !isNaN(d.getTime()) && (isSameDay(d, today) || d > today);
      })
      .sort((a, b) => new Date(a.visitDate!).getTime() - new Date(b.visitDate!).getTime());
  }, [currentTickets]);

  const isShowBanner = useMemo(() => {
    const now = new Date();
    return isThursday(now) && isBefore(now, setMinutes(setHours(now, 10), 0));
  }, []);

  const handleClearActivity = async () => {
    if (activeTickets.length === 0) return;
    
    const count = activeTickets.length;
    
    try {
      setIsSaving(true);
      const allIds = activeTickets.map(t => t.id);
      const chunkSize = 200;
      
      for (let i = 0; i < allIds.length; i += chunkSize) {
        const batch = writeBatch(db);
        allIds.slice(i, i + chunkSize).forEach(id => {
          batch.update(doc(db, 'tickets', id), {
            deletedAt: serverTimestamp(),
            archived: true,
            updatedAt: serverTimestamp()
          });
        });
        await batch.commit();
      }
      
      setImportStatus(`Successfully archived ${count} items.`);
      setTimeout(() => setImportStatus(null), 3000);
      setIsConfirmingClear(false);
    } catch (err: any) {
      console.error("Archive failed:", err);
      alert(`Archive failed: ${err.message}`);
    } finally {
      setIsSaving(false);
      setIsConfirmingClear(false);
    }
  };

  const handleHardDeleteAll = async () => {
    if (historyTickets.length === 0) return;
    if (!window.confirm(`PERMANENTLY delete all ${historyTickets.length} archived records? This cannot be undone.`)) return;

    try {
      setIsSaving(true);
      const allIds = historyTickets.map(t => t.id);
      const chunkSize = 200;
      
      for (let i = 0; i < allIds.length; i += chunkSize) {
        const batch = writeBatch(db);
        allIds.slice(i, i + chunkSize).forEach(id => {
          batch.delete(doc(db, 'tickets', id));
        });
        await batch.commit();
      }
      
      setImportStatus(`Successfully wiped all archived records.`);
      setTimeout(() => setImportStatus(null), 3000);
    } catch (err) {
      console.error("Wipe failed:", err);
      alert("Wipe failed. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canAccessAdmin || !editingTicket) return;

    const data = {
      ticketNumber,
      subject,
      status: pendingStatus || editingTicket.status, // Use the status purely as stored
      visitDate: visitDate || null,
      contactName: contactName || null,
      address: address || null,
      userId: user?.uid || 'admin_pin',
      updatedAt: serverTimestamp(),
    };

    try {
      await updateDoc(doc(db, 'tickets', editingTicket.id), data);
      setIsAddOpen(false);
      setEditingId(null);
      setTicketNumber('');
      setSubject('');
      setVisitDate('');
      setContactName('');
      setAddress('');
      setPendingStatus(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `tickets/${editingTicket.id}`);
    }
  };

  const exportToCSV = () => {
    const exportTickets = tickets.filter(t => !t.deletedAt);
    if (exportTickets.length === 0) {
      alert("No data to export.");
      return;
    }

    const headers = ["Ticket#", "Subject", "Status", "Contact", "Address", "Scheduled Date", "Opened Date", "Modified", "Summary"];
    const csvRows = [headers.join(",")];

    exportTickets.forEach(t => {
      const row = [
        t.ticketNumber,
        `"${(t.subject || '').replace(/"/g, '""')}"`,
        t.status,
        `"${(t.contactName || '').replace(/"/g, '""')}"`,
        `"${(t.address || '').replace(/"/g, '""')}"`,
        `"${(t.visitDate || '').replace(/"/g, '""')}"`,
        t.createdAt?.toDate ? format(t.createdAt.toDate(), 'yyyy-MM-dd') : '',
        t.updatedAt?.toDate ? format(t.updatedAt.toDate(), 'yyyy-MM-dd HH:mm') : '',
        `"${(t.brief || '').replace(/"/g, '""').substring(0, 500)}"`
      ];
      csvRows.push(row.join(","));
    });

    const blob = new Blob([csvRows.join(" ")], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `STS_Audit_Report_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const handleLogout = () => {
    sessionStorage.removeItem('gmail_access_token');
    localStorage.removeItem('sts_admin_level');
    localStorage.removeItem('sts_viewer');
    localStorage.removeItem('sts_pin');
    setAdminLevel(null);
    setPin('');
    setImportStatus(null);
    logout().then(() => {
      window.location.reload(); // Force full reload to reset all states
    });
  };

  const [importQuery, setImportQuery] = useState('from:jseefenkhalil@iltexas.org OR Ticket#');

  const fetchEmailsForImport = async (queryOverride?: string, isSilent = false) => {
    if (isFetchingEmails) return;
    
    if (!isSilent) {
      setIsFetchingEmails(true);
      setImportStatus('Verifying Gmail connection...');
      setIsImportModalOpen(true);
      setImportMode('gmail');
      setSelectableEmails([]);
      setSelectedEmailIds(new Set());
    }
    
    try {
      const accessToken = await getGmailToken();
      if (!accessToken) {
        if (!isSilent) setImportStatus('Gmail authorization required. Please try again.');
        setIsFetchingEmails(false);
        return;
      }
      
      const today = new Date();
      // Searching from start of yesterday UTC to be safe with timezones
      const searchDate = new Date(today);
      searchDate.setDate(today.getDate() - 1);
      const afterDate = format(searchDate, 'yyyy/MM/dd');
      
      const query = (typeof queryOverride === 'string') ? queryOverride : importQuery;
      // Search for messages since yesterday UTC
      const finalQuery = `${query} after:${afterDate}`;
      
      if (!isSilent) setImportStatus(`Searching Gmail since ${afterDate}...`);
      
      const searchRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(finalQuery)}&maxResults=50`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      
      if (!searchRes.ok) {
        if (searchRes.status === 401) {
          sessionStorage.removeItem('gmail_access_token'); // Clear stale token
          throw new Error('Session expired. Please click "Check Again" to reconnect.');
        }
        const errData = await searchRes.json();
        throw new Error(errData.error?.message || `Search failed: ${searchRes.statusText}`);
      }
      
      const searchData = await searchRes.json();

      if (!searchData.messages || searchData.messages.length === 0) {
        if (!isSilent) setImportStatus(`No tickets found since ${afterDate}.`);
        setIsFetchingEmails(false);
        return;
      }

      const emailDetails: { id: string, subject: string, snippet: string, date: Date, ticketNumber: string | null }[] = [];
      
      for (const msg of searchData.messages) {
        // We no longer skip processed messages - user wants to be able to "import anytime"
        // to refresh existing records with new updates from the same email.

        // Fetch full message to be able to search more content if snippet fails
        const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
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

        // Extract more content to find ticket number if not in snippet
        let bodyToSearch = (detailData.snippet || '') + ' ' + subject;
        if (detailData.payload?.parts) {
          const findTextParts = (parts: any[]): string => {
            let text = '';
            for (const p of parts) {
              if (p.mimeType === 'text/plain' && p.body?.data) {
                try {
                  text += atob(p.body.data.replace(/-/g, '+').replace(/_/g, '/'));
                } catch(e) {}
              } else if (p.parts) {
                text += findTextParts(p.parts);
              }
            }
            return text;
          };
          bodyToSearch += ' ' + findTextParts(detailData.payload.parts);
        }

        const ticketMatch = bodyToSearch.match(/Ticket#\s*(\d+)/i) || bodyToSearch.match(/Ticket\s*#\s*:?\s*(\d+)/i);
        const ticketNum = ticketMatch ? ticketMatch[1] : null;

        // SKIP if ticket already exists and is completed
        if (ticketNum) {
          const normNum = ticketNum.replace(/\D/g, '');
          const isCompleted = tickets.some(t => {
            const tNum = (t.ticketNumber || '').replace(/\D/g, '');
            const statusLower = (t.status || '').toLowerCase();
            return tNum === normNum && (statusLower === 'done' || statusLower === 'complete');
          });
          if (isCompleted) {
            console.log(`Filtering out completed ticket #${ticketNum} from import list`);
            continue;
          }
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
        if (!isSilent) setImportStatus("No matching emails found to process.");
      } else {
        setSelectableEmails(emailDetails.sort((a, b) => b.date.getTime() - a.date.getTime()));
        
        // If SILENT and we found new ones, auto-import them!
        if (isSilent && autoSync) {
          const ids = new Set(emailDetails.map(e => e.id));
          autoImportEmails(Array.from(ids));
        }
        
        if (!isSilent) setImportStatus(null);
      }
    } catch (error: any) {
      console.error(error);
      if (!isSilent) setImportStatus(error.message || 'Error fetching emails.');
    } finally {
      setIsFetchingEmails(false);
    }
  };

  useEffect(() => {
    if (!autoSync || !canAccessAdmin) return;
    
    // Initial fetch
    fetchEmailsForImport(undefined, true);
    
    const interval = setInterval(() => {
      fetchEmailsForImport(undefined, true);
    }, 60000); // Pulse every 60 seconds
    
    return () => clearInterval(interval);
  }, [autoSync, canAccessAdmin, tickets.length]);

  const importManualContent = async () => {
    if (!manualContent.trim() || isImporting) return;
    setIsImporting(true);
    setImportStatus('Parsing content...');

    try {
      const { ticketNumber: parsedNumber, subject, status, contactName: cName, address: addr, visitDate: vDate, brief, content, htmlContent } = parseEmailHTML(manualContent, '');
      
      const ticketNumber = (manualTicketNumber.trim() || parsedNumber).trim();

      if (ticketNumber && (subject || manualContent.length > 50)) {
        const ticketSub = subject || "Manual Import - " + ticketNumber;
        const normalizedInput = ticketNumber.replace(/\D/g, '');
        const existing = tickets.find(t => {
          const tNum = (t.ticketNumber || '').replace(/\D/g, '');
          return tNum === normalizedInput && tNum.length > 0;
        });
        const finalStatus = getStatusFromSubject(ticketSub, status, content || brief);
        
        if (!existing) {
          if (!user && !adminLevel) {
            setImportStatus('You must be logged in as Admin to import.');
            setIsImporting(false);
            return;
          }
          await addDoc(collection(db, 'tickets'), {
            ticketNumber,
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
          // Update existing
          await updateDoc(doc(db, 'tickets', existing.id), {
            status: finalStatus,
            subject: ticketSub || existing.subject,
            brief: brief || existing.brief || '',
            content: (existing.content ? existing.content + '\n\n' : '') + (content || ''),
            visitDate: vDate || existing.visitDate,
            contactName: cName || existing.contactName,
            address: addr || existing.address,
            updatedAt: serverTimestamp(),
            archived: false,
            deletedAt: null,
            notes: (existing.notes ? existing.notes + '\n' : '') + `Manually updated at ${new Date().toLocaleString()}`
          });
          setImportStatus(`Ticket #${ticketNumber} updated and restored!`);
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

  const autoImportEmails = async (msgIds: string[]) => {
    if (msgIds.length === 0) return;
    try {
      const accessToken = await getGmailToken();
      if (!accessToken) return;
      await processAndImportEmails(msgIds, accessToken, true);
    } catch (error) {
      console.error("Auto-import error:", error);
    }
  };

  const processAndImportEmails = async (msgIds: string[], accessToken: string, isSilentCall = false) => {
    let importedCount = 0;
    
    // Refresh existing tickets from DB to ensure we have current number set
    // (tickets variable from useTickets is already synced via onSnapshot)
    
    for (let i = 0; i < msgIds.length; i++) {
      const msgId = msgIds[i];
      if (!isSilentCall) setImportStatus(`Processing email ${i + 1}/${msgIds.length}...`);
      
      const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const detailData = await detailRes.json();
      if (!detailData.payload) continue;

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
         htmlContent = getBody(detailData.payload.parts || [detailData.payload]) || detailData.snippet || '';
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

      if (htmlContent || innerSubject) {
        const { ticketNumber: rawNum, subject: parsedSubject, status: rawStatus, contactName: cName, address: addr, visitDate: vDate, brief, content, htmlContent: extractedHtml } = parseEmailHTML(htmlContent || '', innerSubject);
        const ticketNumber = (rawNum || '').trim();
        
        if (ticketNumber && parsedSubject) {
          const normalizedNum = ticketNumber.replace(/\D/g, '');
          const existing = tickets.find(t => {
            const tNum = (t.ticketNumber || '').replace(/\D/g, '');
            return tNum === normalizedNum && tNum.length > 0;
          });
          

          if (existing) {
            const normalizedStatus = (existing.status || '').toLowerCase();
            if (normalizedStatus === 'done' || normalizedStatus === 'complete') {
              console.log(`Skipping completed ticket #${ticketNumber}`);
              continue;
            }
          }
          
          const finalStatus = getStatusFromSubject(parsedSubject, rawStatus, content || brief);
          
          if (!existing) {
            await addDoc(collection(db, 'tickets'), {
              ticketNumber,
              subject: parsedSubject,
              status: finalStatus,
              brief: brief || '',
              content: content || '',
              htmlContent: extractedHtml || '',
              visitDate: vDate || null,
              contactName: cName || '',
              address: addr || '',
              userId: user?.uid || adminLevel || 'SYSTEM',
              processedMessageIds: [msgId],
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            importedCount++;
          } else {
            // Update existing ticket instead of creating new
            await updateDoc(doc(db, "tickets", existing.id), {
              status: finalStatus,
              brief: brief || existing.brief || "",
              content:
                (existing.content ? existing.content + "\n\n" : "") +
                (content || ""),
              htmlContent: extractedHtml || existing.htmlContent || "",
              visitDate: vDate || existing.visitDate,
              processedMessageIds: arrayUnion(msgId),
              updatedAt: serverTimestamp(),
              archived: false,
              deletedAt: null,
            });
            importedCount++;
          }
        }
      }
    }
    return importedCount;
  };

  const importSelectedEmails = async () => {
    if (isImporting || selectedEmailIds.size === 0) return;
    setIsImporting(true);
    setImportStatus(`Importing ${selectedEmailIds.size} tickets...`);
    
    try {
      const accessToken = await getGmailToken();
      if (!accessToken) return;

      const idsToProcess = [...selectedEmailIds];
      const newCount = await processAndImportEmails(idsToProcess, accessToken);

      setImportStatus(`Success! Processed ${newCount} updates.`);
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

  const handleDelete = async (id: string) => {
    if (!window.confirm("Are you sure you want to permanently delete this ticket?")) return;
    setIsSaving(true);
    try {
      await deleteDoc(doc(db, 'tickets', id));
      setIsAddOpen(false);
      setEditingId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `tickets/${id}`);
    } finally {
      setIsSaving(false);
    }
  };

  const openEdit = (ticket: Ticket) => {
    setEditingId(ticket.id);
    setPendingStatus(ticket.status);
    setTicketNumber(ticket.ticketNumber);
    setSubject(ticket.subject);
    setVisitDate(ticket.visitDate || '');
    setContactName(ticket.contactName || '');
    setAddress(ticket.address || '');
    setIsAddOpen(true);
    setIsDeleting(false);
    setIsSaving(false);
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
            <h1 className="text-2xl font-black tracking-tighter italic">STS TICKETS TRACKER</h1>
            <p className="text-white/60 text-[10px] mt-1 uppercase tracking-[0.3em] font-bold">Splendid Technology Services</p>
          </div>

          <div className="p-8 space-y-8">
            <div className="space-y-4">
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
                        }
                      }}
                    />
                    {pin.length === 4 && pin !== '7324' && (
                      <p className="text-red-500 text-[10px] font-bold text-center mt-2 uppercase animate-bounce">Access Denied</p>
                    )}
                  </div>
                </div>

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
      
      {/* Today Visit Banner */}
      <AnimatePresence>
        {showTodayBanner && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="bg-red-600 px-6 py-5 flex flex-col justify-center items-center gap-3 z-[70] shrink-0 cursor-pointer shadow-2xl relative overflow-hidden"
            onClick={() => setView('dashboard')}
          >
            <motion.div 
              animate={{ opacity: [1, 0.7, 1] }}
              transition={{ repeat: Infinity, duration: 2 }}
              className="flex items-center gap-4 border-b border-white/20 pb-2 w-full justify-center"
            >
              <ShieldAlert size={24} className="text-white" />
              <span className="font-black text-sm lg:text-base tracking-[0.2em] text-white uppercase italic text-center drop-shadow-lg">
                🚨 VENDOR VISITING CAMPUS TODAY — {todayVisits.length} {todayVisits.length === 1 ? 'VISIT' : 'VISITS'} SCHEDULED 🚨
              </span>
              <ShieldAlert size={24} className="text-white" />
            </motion.div>
            
            <div className="flex flex-wrap justify-center gap-x-8 gap-y-1 max-w-5xl">
              {todayVisits.map(t => (
                <div key={t.id} className="text-[10px] lg:text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <span className="opacity-70">Ticket #{t.ticketNumber}</span>
                  <span className="w-1 h-1 rounded-full bg-white/40" />
                  <span>{t.subject}</span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-red-500"></div> <strong className="text-white">OPEN:</strong> {stats.open.toString().padStart(2, '0')}</span>
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div> <strong className="text-white">SCHEDULED:</strong> {stats.scheduled.toString().padStart(2, '0')}</span>
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div> <strong className="text-white">COMPLETE:</strong> {stats.done.toString().padStart(2, '0')}</span>
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-amber-500"></div> <strong className="text-white">W-INV:</strong> {stats.w_invoice.toString().padStart(2, '0')}</span>
              <span className="flex items-center gap-1.5"><div className="w-1.5 h-1.5 rounded-full bg-orange-500"></div> <strong className="text-white">W-PARTS:</strong> {stats.w_parts.toString().padStart(2, '0')}</span>
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
                      {selectableEmails.length} New Tickets Detected
                    </span>
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
                        {importStatus && importStatus.includes('expired') ? 'Check Again' : 'Sync Gmail'}
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
                        <p className="text-sm text-dash-muted italic">No recent un-imported tickets found.</p>
                        <p className="text-[10px] text-dash-muted uppercase font-bold tracking-widest mt-4 mb-6">
                           Scanning Splendid ticket notifications from the last 3 days.
                        </p>
                        <button 
                          onClick={() => fetchEmailsForImport()}
                          className="px-8 py-3 bg-dash-bg border border-dash-border rounded-xl text-xs font-bold uppercase tracking-widest hover:border-dash-accent hover:text-dash-accent transition-all"
                        >
                          Check Again
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
                        {importMode === 'gmail' && selectableEmails.length > 0 && (
                          <button 
                            onClick={() => {
                              if (selectedEmailIds.size === selectableEmails.length) {
                                setSelectedEmailIds(new Set());
                              } else {
                                const allIds = new Set(selectableEmails.map(e => e.id));
                                setSelectedEmailIds(allIds);
                              }
                            }}
                            className="px-6 py-2.5 bg-white border border-dash-border text-[10px] font-black uppercase tracking-widest text-dash-accent hover:bg-dash-bg transition-all rounded-xl shadow-sm"
                          >
                            {selectedEmailIds.size === selectableEmails.length ? 'Deselect All' : 'Select Recent'}
                          </button>
                        )}
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
            <h1 className="text-lg font-black tracking-tight italic text-dash-accent uppercase">STS Tickets Tracker</h1>
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
              {todayVisits.length === 0 ? (
                <p className="text-[10px] text-dash-muted px-2">No visits scheduled for today.</p>
              ) : (
                todayVisits.map(v => (
                    <button 
                      key={v.id} 
                      onClick={() => openEdit(v)}
                      className="w-full text-left bg-dash-accent/10 border border-dash-accent/20 p-3 rounded-lg hover:bg-dash-accent/20 transition-all group"
                    >
                      <div className="text-[10px] text-dash-accent font-bold mb-1 uppercase flex items-center justify-between">
                        Campus Visit
                        <div className="w-1.5 h-1.5 rounded-full bg-dash-accent animate-pulse" />
                      </div>
                      <div className="text-sm font-black tracking-tight italic">Ticket #{v.ticketNumber}</div>
                      <div className="text-[10px] text-dash-muted mt-1 uppercase truncate font-bold">{v.subject}</div>
                    </button>
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
                onClick={() => handleLogout()}
                className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-dash-muted hover:text-dash-accent transition-colors"
              >
                <LogOut size={14} />
                Logout
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
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                    <button 
                      onClick={() => setStatusFilter('All')}
                      className={cn(
                        "bg-dash-card p-4 border rounded-xl shadow-sm transition-all text-left group min-h-[90px]",
                        statusFilter === 'All' ? "border-dash-accent ring-1 ring-dash-accent bg-dash-accent/5" : "border-dash-border hover:border-dash-accent"
                      )}
                    >
                      <div className="text-[9px] text-dash-muted font-bold uppercase tracking-widest mb-1 group-hover:text-dash-text transition-colors">Total Tickets</div>
                      <div className="text-2xl font-bold">{stats.total}</div>
                    </button>
                    <button 
                      onClick={() => setStatusFilter('Open')}
                      className={cn(
                        "bg-dash-card p-4 border rounded-xl shadow-sm transition-all text-left group min-h-[90px]",
                        statusFilter === 'Open' ? "border-red-500 ring-2 ring-red-500/20 bg-red-500/10" : "border-dash-border hover:border-red-400"
                      )}
                    >
                      <div className="text-[9px] font-bold uppercase tracking-widest mb-1 text-red-600">🔴 Open</div>
                      <div className="text-2xl font-bold text-red-600">{stats.open.toString().padStart(2, '0')}</div>
                    </button>
                    <button 
                      onClick={() => setStatusFilter('Scheduled')}
                      className={cn(
                        "bg-dash-card p-4 border rounded-xl shadow-sm transition-all text-left group min-h-[90px]",
                        statusFilter === 'Scheduled' ? "border-blue-500 ring-2 ring-blue-500/20 bg-blue-500/10" : "border-dash-border hover:border-blue-400"
                      )}
                    >
                      <div className="text-[9px] font-bold uppercase tracking-widest mb-1 text-blue-600">🗓 Scheduled</div>
                      <div className="text-2xl font-bold text-blue-600">{stats.scheduled.toString().padStart(2, '0')}</div>
                    </button>
                    <button 
                      onClick={() => setStatusFilter('Waiting for Invoice')}
                      className={cn(
                        "bg-dash-card p-4 border rounded-xl shadow-sm transition-all text-left group min-h-[90px]",
                        statusFilter === 'Waiting for Invoice' ? "border-amber-500 ring-2 ring-amber-500/20 bg-amber-500/10" : "border-dash-border hover:border-amber-400"
                      )}
                    >
                      <div className="text-[9px] font-bold uppercase tracking-widest mb-1 text-amber-600">🧾 W-Invoice</div>
                      <div className="text-2xl font-bold text-amber-600">{stats.w_invoice.toString().padStart(2, '0')}</div>
                    </button>
                    <button 
                      onClick={() => setStatusFilter('Waiting for Parts')}
                      className={cn(
                        "bg-dash-card p-4 border rounded-xl shadow-sm transition-all text-left group min-h-[90px]",
                        statusFilter === 'Waiting for Parts' ? "border-orange-500 ring-2 ring-orange-500/20 bg-orange-500/10" : "border-dash-border hover:border-orange-400"
                      )}
                    >
                      <div className="text-[9px] font-bold uppercase tracking-widest mb-1 text-orange-600">📦 W-Parts</div>
                      <div className="text-2xl font-bold text-orange-600">{stats.w_parts.toString().padStart(2, '0')}</div>
                    </button>
                    <button 
                      onClick={() => setStatusFilter('Done')}
                      className={cn(
                        "bg-dash-card p-4 border rounded-xl shadow-sm transition-all text-left group min-h-[90px]",
                        statusFilter === 'Done' ? "border-emerald-500 ring-2 ring-emerald-500/20 bg-emerald-500/10" : "border-dash-border hover:border-emerald-400"
                      )}
                    >
                      <div className="text-[9px] font-bold uppercase tracking-widest mb-1 text-emerald-600">✅ Complete</div>
                      <div className="text-2xl font-bold text-emerald-600">{stats.done.toString().padStart(2, '0')}</div>
                    </button>
                  </div>

                  {/* Header/Controls */}
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                      <h1 className="text-2xl font-black italic tracking-tighter uppercase flex items-center gap-2">
                        <LayoutDashboard className="text-dash-accent" />
                        Operations
                      </h1>
                      {canAccessAdmin && !showHistory && (
                        <div className={cn(
                          "flex items-center gap-3 px-4 py-2 rounded-xl border transition-all duration-300",
                          isConfirmingClear ? "bg-red-600 border-red-700 shadow-lg" : "bg-red-500/5 border-red-500/20 shadow-sm"
                        )}>
                          {isConfirmingClear ? (
                            <div className="flex items-center gap-4">
                              <span className="text-[10px] font-black uppercase tracking-widest text-white animate-pulse">
                                Confirm Archive {activeTickets.length}?
                              </span>
                              <div className="flex items-center gap-2">
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    handleClearActivity();
                                  }}
                                  disabled={isSaving}
                                  className="px-3 py-1 bg-white text-red-600 text-[10px] font-black rounded-lg hover:bg-gray-100 transition-colors uppercase tracking-widest"
                                >
                                  {isSaving ? "Clearing..." : "Yes, Clear"}
                                </button>
                                <button
                                  onClick={() => setIsConfirmingClear(false)}
                                  disabled={isSaving}
                                  className="px-3 py-1 bg-red-700/50 text-white text-[10px] font-black rounded-lg hover:bg-red-700 transition-colors uppercase tracking-widest"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <span className="text-[10px] font-black uppercase tracking-tighter text-red-500">
                                Clear Dashboard
                              </span>
                              <button 
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  if (activeTickets.length > 0) setIsConfirmingClear(true);
                                }}
                                disabled={isSaving || activeTickets.length === 0}
                                className={cn(
                                  "w-12 h-6 rounded-full transition-all relative flex items-center p-1 cursor-pointer",
                                  activeTickets.length > 0 ? "bg-red-500" : "bg-gray-200"
                                )}
                              >
                                <div className={cn(
                                  "h-4 w-4 bg-white rounded-full transition-all shadow-md transform",
                                  isSaving ? "left-1/2 -translate-x-1/2 animate-pulse" : "translate-x-0"
                                )} />
                              </button>
                            </>
                          )}
                        </div>
                      )}
                      {showHistory && (
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 text-[10px] font-black uppercase tracking-widest">
                            <History size={12} />
                            Archive
                          </div>
                          {canAccessFullAdmin && historyTickets.length > 0 && (
                            <button
                              onClick={handleHardDeleteAll}
                              disabled={isSaving}
                              className="px-3 py-1.5 bg-red-500/10 border border-red-500/20 text-red-600 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-red-500 hover:text-white transition-all disabled:opacity-50"
                            >
                              Wipe Archive
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2 bg-dash-card border border-dash-border px-3 py-1.5 rounded-xl text-[10px] font-bold uppercase tracking-widest text-dash-muted">
                        <span>View Records</span>
                        <button 
                          onClick={() => setShowHistory(!showHistory)}
                          className={cn(
                            "w-6 h-3 rounded-full transition-all relative",
                            showHistory ? "bg-red-500" : "bg-dash-border"
                          )}
                        >
                          <div className={cn(
                            "absolute top-0.5 w-2 h-2 bg-white rounded-full transition-all",
                            showHistory ? "right-0.5" : "left-0.5"
                          )} />
                        </button>
                      </div>
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
                          setEditingId(null);
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
                                    <div className="flex flex-wrap items-center gap-3 mt-1.5">
                                       <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-dash-bg border border-dash-border/50 text-[10px] font-bold text-dash-muted">
                                          <Calendar size={10} className="text-dash-muted opacity-60" />
                                          <span className="opacity-50">OPENED:</span>
                                          {t.createdAt ? (t.createdAt as any).toDate().toLocaleDateString('en-CA') : 'N/A'}
                                       </div>
                                       {t.visitDate && (
                                         <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-dash-accent/5 border border-dash-accent/20 text-[10px] font-black text-dash-accent uppercase italic">
                                            <Clock size={10} className="text-dash-accent" />
                                            <span>Scheduled: {t.visitDate}</span>
                                         </div>
                                       )}
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
                                      {canAccessAdmin && (
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleDelete(t.id);
                                          }}
                                          className="p-1.5 hover:bg-red-500/10 text-dash-muted hover:text-red-500 rounded-lg transition-all"
                                          title="Delete Ticket"
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
                                    <div className="flex flex-col items-end gap-0.5">
                                       <span className="text-[8px] font-bold text-dash-muted uppercase">Opened: {v.createdAt ? (v.createdAt as any).toDate().toLocaleDateString('en-CA') : 'N/A'}</span>
                                       <span className="text-[9px] font-black uppercase text-dash-accent italic leading-none">Visit: {v.visitDate || 'PENDING'}</span>
                                    </div>
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
                      <Activity className="text-blue-500" />
                      Live Activity Command
                    </h2>
                    <p className="text-dash-muted text-[10px] font-bold uppercase tracking-[0.2em] mt-1">
                      Current Operational Period: {format(selectedWeek.start, 'MMM d')} - {format(selectedWeek.end, 'MMM d, yyyy')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 bg-dash-card border border-dash-border p-1 rounded-xl shadow-sm">
                    {canAccessAdmin && activeTickets.length > 0 && !showHistory && (
                      <button 
                        onClick={handleClearActivity}
                        disabled={isSaving}
                        className="px-4 py-2 text-[10px] font-black uppercase tracking-widest bg-red-500 text-white hover:bg-red-600 rounded-lg transition-all flex items-center gap-2 border-r border-dash-border shadow-lg shadow-red-500/20"
                      >
                        <History size={14} />
                        Archive Board
                      </button>
                    )}
                    {showHistory && (
                      <button 
                        onClick={() => setShowHistory(false)}
                        className="px-4 py-2 text-[10px] font-black uppercase tracking-widest bg-emerald-500 text-white hover:bg-emerald-600 rounded-lg transition-all flex items-center gap-2 border-r border-dash-border shadow-lg shadow-emerald-500/20"
                      >
                        <History size={14} />
                        Exit Records
                      </button>
                    )}
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
                    <div className="flex items-center gap-2 text-blue-500">
                      <Calendar size={18} />
                      <h3 className="text-xs font-black uppercase tracking-widest italic">Upcoming Visits</h3>
                      <span className="ml-auto text-[10px] font-bold py-1 px-3 bg-blue-500/10 border border-blue-500/20 rounded-full text-blue-600">{activityGroups.scheduled.length}</span>
                    </div>
                    <div className="space-y-4">
                      {activityGroups.scheduled.map(t => (
                        <div key={t.id} className="bg-dash-card border border-blue-500/10 p-5 rounded-2xl shadow-sm hover:shadow-lg transition-all border-l-4 border-l-blue-500 cursor-pointer group" onClick={() => openEdit(t)}>
                          <div className="flex justify-between items-start mb-3">
                            <div className="flex flex-col gap-1">
                              <span className="text-[10px] font-mono text-dash-muted font-bold uppercase">Opened: {t.createdAt ? (t.createdAt as any).toDate().toLocaleDateString('en-CA') : 'N/A'}</span>
                              <span className="text-[11px] font-black italic text-blue-600 uppercase tracking-tighter">Visit: {t.visitDate || 'No date set'}</span>
                            </div>
                            <span className="text-[9px] font-bold text-dash-muted uppercase bg-dash-bg px-2 py-0.5 rounded border border-dash-border/50">#{t.ticketNumber}</span>
                          </div>
                          <div className="font-bold text-sm leading-tight group-hover:text-blue-600 transition-colors mb-2 uppercase italic">{t.subject}</div>
                          <div className="text-[10px] text-dash-muted font-medium truncate italic">{t.address || 'No location provided'}</div>
                        </div>
                      ))}
                      {activityGroups.scheduled.length === 0 && <p className="text-[10px] text-dash-muted italic text-center py-10">No upcoming visits scheduled.</p>}
                    </div>
                  </div>
   
                  {/* Completed */}
                  <div className="flex flex-col gap-5">
                    <div className="flex items-center gap-2 text-emerald-500">
                      <CheckCircle2 size={18} />
                      <h3 className="text-xs font-black uppercase tracking-widest italic">Resolved Hub</h3>
                      <span className="ml-auto text-[10px] font-bold py-1 px-3 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-emerald-600">{activityGroups.completed.length}</span>
                    </div>
                    <div className="space-y-4">
                      {activityGroups.completed.map(t => (
                        <div key={t.id} className="bg-dash-card border border-emerald-500/10 p-5 rounded-2xl shadow-sm hover:shadow-md transition-all border-l-4 border-l-emerald-500 cursor-pointer group" onClick={() => openEdit(t)}>
                          <div className="flex justify-between items-start mb-2">
                             <div className="flex flex-col gap-0.5">
                                <div className="text-[9px] font-mono text-dash-muted font-bold uppercase tracking-tighter">Reference #{t.ticketNumber}</div>
                                <div className="text-[8px] font-bold text-dash-muted uppercase">Opened: {t.createdAt ? (t.createdAt as any).toDate().toLocaleDateString('en-CA') : 'N/A'}</div>
                             </div>
                             {t.visitDate && <div className="text-[9px] font-black italic text-emerald-600 bg-emerald-500/5 px-1.5 py-0.5 rounded border border-emerald-500/10">Visit: {t.visitDate}</div>}
                          </div>
                          <div className="font-bold text-sm leading-tight mb-3 group-hover:text-emerald-600 transition-colors italic">{t.subject}</div>
                          <div className="flex items-center gap-2 text-emerald-600 text-[10px] font-black uppercase">
                             <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
                             Marked Complete
                          </div>
                        </div>
                      ))}
                      {activityGroups.completed.length === 0 && <p className="text-[10px] text-dash-muted italic text-center py-10">Historical records cleared.</p>}
                    </div>
                  </div>
   
                  {/* Waiting */}
                  <div className="flex flex-col gap-5">
                    <div className="flex items-center gap-2 text-red-500">
                      <AlertCircle size={18} className="animate-pulse" />
                      <h3 className="text-xs font-black uppercase tracking-widest italic">Active Queue</h3>
                      <span className="ml-auto text-[10px] font-bold py-1 px-3 bg-red-500/10 border border-red-500/20 rounded-full text-red-600">{activityGroups.waiting.length}</span>
                    </div>
                    <div className="space-y-4">
                      {activityGroups.waiting.map(t => (
                        <div key={t.id} className="bg-dash-card border-red-500/10 p-5 rounded-2xl shadow-sm hover:shadow-lg transition-all border-l-4 border-l-red-500 cursor-pointer group" onClick={() => openEdit(t)}>
                          <div className="flex justify-between items-start mb-2">
                             <div className="flex flex-col gap-0.5">
                                <div className="text-[9px] font-mono text-dash-muted font-bold uppercase tracking-tighter">Ticket #{t.ticketNumber}</div>
                                <div className="text-[8px] font-bold text-dash-muted uppercase">Opened: {t.createdAt ? (t.createdAt as any).toDate().toLocaleDateString('en-CA') : 'N/A'}</div>
                             </div>
                             {t.visitDate && <div className="text-[9px] font-black italic text-red-600 bg-red-500/5 px-1.5 py-0.5 rounded border border-red-500/10">Visit: {t.visitDate}</div>}
                          </div>
                          <div className="font-bold text-sm leading-tight mb-3 group-hover:text-red-600 transition-colors font-black uppercase italic">{t.subject}</div>
                          <div className="flex items-center gap-2">
                             <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.5)]"></div>
                             <span className="text-[9px] text-red-600 font-black uppercase tracking-tight">Requires Attention</span>
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
                {editingTicket && (
                  <div className="ml-auto mr-4">
                    <StatusBadge status={editingTicket.status} />
                  </div>
                )}
                <button onClick={() => setIsAddOpen(false)} className="p-2 bg-dash-border rounded hover:bg-dash-muted transition-colors text-dash-text">
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-6">
                 {/* MANUAL STATUS EDITOR */}
                 <div className="p-6 rounded-3xl bg-dash-bg border border-dash-border shadow-inner">
                   <label className="block text-[10px] font-black uppercase tracking-[0.2em] text-dash-muted mb-4">Manual Status Override</label>
                   <div className="grid grid-cols-2 gap-2">
                      {[
                        { id: 'Open', label: 'Open', icon: '🔴', color: 'border-red-500 text-red-600 bg-red-50' },
                        { id: 'Scheduled', label: 'Scheduled', icon: '🗓', color: 'border-blue-500 text-blue-600 bg-blue-50' },
                        { id: 'Waiting for Invoice', label: 'W-Invoice', icon: '🧾', color: 'border-amber-500 text-amber-600 bg-amber-50' },
                        { id: 'Waiting for Parts', label: 'W-Parts', icon: '📦', color: 'border-orange-500 text-orange-600 bg-orange-50' },
                        { id: 'Done', label: 'Complete', icon: '✅', color: 'border-emerald-500 text-emerald-600 bg-emerald-50' }
                      ].map(s => {
                        const isActive = pendingStatus === s.id;
                        return (
                          <button
                            key={s.id}
                            onClick={() => setPendingStatus(s.id)}
                            className={cn(
                              "px-4 py-3 rounded-xl border-2 text-[10px] font-black uppercase tracking-tighter flex items-center gap-2 transition-all shadow-sm",
                              isActive ? s.color : "border-dash-border bg-white text-dash-muted hover:border-dash-muted"
                            )}
                          >
                             <span className="text-sm">{s.icon}</span>
                             {s.label}
                          </button>
                        )
                      })}
                   </div>

                   {pendingStatus === 'Scheduled' && (
                     <motion.div 
                       initial={{ height: 0, opacity: 0 }}
                       animate={{ height: 'auto', opacity: 1 }}
                       className="mt-4 pt-4 border-t border-dash-border space-y-2"
                     >
                       <label className="text-[9px] font-bold uppercase text-dash-muted">Select Visit Date</label>
                       <input 
                         type="date"
                         value={visitDate.match(/^\d{4}-\d{2}-\d{2}$/) ? visitDate : ''}
                         onChange={(e) => setVisitDate(e.target.value)}
                         className="w-full bg-white border-2 border-blue-500/20 rounded-xl px-4 py-3 text-sm font-bold text-blue-600 focus:outline-none focus:border-blue-500 transition-all"
                       />
                     </motion.div>
                   )}

                   {/* Save Button for Manual Override */}
                   <div className="mt-6">
                     <button
                       onClick={async () => {
                         if (!editingTicket || !pendingStatus) return;
                         setIsManualSaving(true);
                         try {
                           const updates: any = { status: pendingStatus, manualStatusOverride: true, visitDate: visitDate || null, updatedAt: serverTimestamp() };

                           await updateDoc(doc(db, 'tickets', editingTicket.id), updates);
                           
                         } catch (err) {
                           console.error(err);
                         } finally {
                           setIsManualSaving(false);
                         }
                       }}
                       disabled={isManualSaving || (pendingStatus === editingTicket?.status && (pendingStatus !== 'Scheduled' || visitDate === editingTicket?.visitDate))}
                       className="w-full bg-dash-accent text-white py-4 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:brightness-110 shadow-lg shadow-dash-accent/20 transition-all disabled:opacity-50 disabled:grayscale"
                      >
                        {isManualSaving ? 'Saving Changes...' : 'Save Manual Override'}
                      </button>
                    </div>
                  </div>

                {editingTicket && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="p-4 rounded-xl bg-dash-border/30 border border-dash-border">
                      <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-1 text-center">Opened Date</label>
                      <div className="text-sm font-bold text-center">
                        {editingTicket.createdAt ? (editingTicket.createdAt as any).toDate().toLocaleDateString('en-CA') : 'N/A'}
                      </div>
                    </div>
                    <div className="p-4 rounded-xl bg-dash-accent/10 border border-dash-accent/30 shadow-sm shadow-dash-accent/10">
                      <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-accent mb-1 text-center">Scheduled Date</label>
                      <div className="text-base font-black text-dash-accent text-center italic">
                        {editingTicket.visitDate || 'PENDING'}
                      </div>
                    </div>
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
                  {editingTicket && canAccessAdmin && (
                    <button 
                      type="button"
                      disabled={isSaving}
                      onClick={async () => {
                        setIsSaving(true);
                        try {
                          const data = {
                            ticketNumber,
                            subject,
                            visitDate: visitDate || null,
                            address: address || null,
                            updatedAt: serverTimestamp()
                          };
                          await updateDoc(doc(db, 'tickets', editingTicket.id), data);
                          setIsAddOpen(false);
                        } catch (err: any) {
                          console.error("Update failed:", err);
                        } finally {
                          setIsSaving(false);
                        }
                      }}
                      className="w-full bg-dash-accent text-white py-4 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:brightness-110 shadow-lg shadow-dash-accent/20 transition-all disabled:opacity-50"
                    >
                      {isSaving ? 'Synchronizing...' : 'Save Meta-Data Changes'}
                    </button>
                  )}

                  {editingTicket && (getStatusFromSubject(subject).toLowerCase().includes('done') || getStatusFromSubject(subject).toLowerCase().includes('complete') || getStatusFromSubject(subject, editingTicket.status).toLowerCase().includes('done')) && (
                    <button 
                      type="button"
                      onClick={async () => {
                        if (editingTicket) {
                          try {
                            await updateDoc(doc(db, 'tickets', editingTicket.id), { archived: true });
                            setIsAddOpen(false);
                            alert("Ticket archived.");
                          } catch (err: any) {
                            console.error("Archive failed:", err);
                            alert(`Archive failed: ${err.message}`);
                          }
                        }
                      }}
                      className="w-full bg-dash-bg border border-dash-border py-4 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:border-dash-secondary/30 transition-all flex items-center justify-center gap-2 group"
                    >
                      <CheckCircle2 size={14} className="text-dash-secondary" />
                      Archive Closed Ticket
                    </button>
                  )}
                  
                  {editingTicket && canAccessAdmin && (
                    <button 
                      type="button"
                      onClick={() => handleDelete(editingTicket.id)}
                      className="w-full bg-red-500/10 border border-red-500/20 py-4 rounded-xl font-bold text-[10px] uppercase tracking-widest text-red-600 hover:bg-red-600 hover:text-white transition-all flex items-center justify-center gap-2 group"
                    >
                      <Trash2 size={14} />
                      Purge Record Permanently
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
