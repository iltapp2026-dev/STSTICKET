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
  Download
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

function StatusBadge({ status }: { status: Ticket['status'] }) {
  const styles = {
    'Done': 'bg-dash-secondary/20 text-dash-secondary border-dash-secondary/30',
    'In Progress': 'bg-dash-gold/20 text-dash-gold border-dash-gold/30',
    'Visit Scheduled': 'bg-dash-accent text-white border-dash-accent',
    'Open': 'bg-dash-blue/20 text-dash-blue border-dash-blue/30',
  };

  return (
    <span className={cn(
      "px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest border w-fit",
      styles[status]
    )}>
      {status}
    </span>
  );
}

export default function App() {
  const { user, loading: authLoading } = useAuth();
  const [isViewer, setIsViewer] = useState(false);
  const [pin, setPin] = useState('');
  const [loginMode, setLoginMode] = useState<'admin' | 'viewer'>('admin');
  
  const isAdmin = !!user;
  const isAuthenticated = isAdmin || isViewer;
  
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
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [editingTicket, setEditingTicket] = useState<Ticket | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);

  const selectedWeek = useMemo(() => {
    const d = addWeeks(new Date(), weekOffset);
    return {
      start: startOfWeek(d, { weekStartsOn: 1 }),
      end: endOfWeek(d, { weekStartsOn: 1 })
    };
  }, [weekOffset]);

  const activityGroups = useMemo(() => {
    const weekTickets = tickets.filter(t => {
      const date = t.updatedAt?.toDate ? t.updatedAt.toDate() : new Date();
      return isWithinInterval(date, selectedWeek);
    });

    return {
      completed: weekTickets.filter(t => t.status === 'Done'),
      scheduled: tickets.filter(t => t.status === 'Visit Scheduled' && t.visitDate && isSameWeek(new Date(t.visitDate), selectedWeek.start, { weekStartsOn: 1 })),
      waiting: weekTickets.filter(t => t.status === 'In Progress' || t.status === 'Open'),
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
      const matchesStatus = statusFilter === 'All' || t.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [tickets, search, statusFilter]);

  const stats = useMemo(() => ({
    total: tickets.length,
    open: tickets.filter(t => t.status === 'Open').length,
    progress: tickets.filter(t => t.status === 'In Progress').length,
    done: tickets.filter(t => t.status === 'Done').length,
    visits: tickets.filter(t => t.status === 'Visit Scheduled').length,
  }), [tickets]);

  const upcomingVisits = useMemo(() => {
    return tickets
      .filter(t => t.status === 'Visit Scheduled' && t.visitDate)
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
      status: getStatusFromSubject(subject),
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
    localStorage.removeItem('gmailToken');
    localStorage.removeItem('lastAutoSync');
    setSyncStatus(null);
    logout();
  };

  const syncGmail = () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncStatus('Connecting to Gmail...');

    // Use environment variable if available, otherwise fallback.
    // In AIS, we might not have it in env, so we use the one derived from the project if possible.
    const CLIENT_ID = (import.meta as any).env.VITE_GOOGLE_CLIENT_ID || '398175493670-igb2ojljtyalzueabf5asj.apps.googleusercontent.com'; 
    const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';

    try {
      // @ts-ignore
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: async (response: any) => {
          if (response.error) {
            setSyncStatus('Auth Error: ' + response.error);
            setIsSyncing(false);
            return;
          }

          const accessToken = response.access_token;
          setSyncStatus('Searching for Splendid emails...');

          try {
            const query = 'support@splendidtechnology.com jseefenkhalil@iltexas.org';
            const searchRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=30`, {
              headers: { Authorization: `Bearer ${accessToken}` }
            });
            const searchData = await searchRes.json();

            if (!searchData.messages) {
              setSyncStatus('No emails found.');
              setIsSyncing(false);
              return;
            }

            let foundCount = 0;
            let newCount = 0;

            for (const msg of searchData.messages) {
              setSyncStatus(`Reading message ${++foundCount}/${searchData.messages.length}...`);
              const detailRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
                headers: { Authorization: `Bearer ${accessToken}` }
              });
              const detailData = await detailRes.json();

              let html = '';
              const parts = detailData.payload.parts || [detailData.payload];
              for (const part of parts) {
                if (part.mimeType === 'text/html' && part.body.data) {
                  html = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
                  break;
                }
                if (part.parts) {
                   for (const subPart of part.parts) {
                     if (subPart.mimeType === 'text/html' && subPart.body.data) {
                       html = atob(subPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
                       break;
                     }
                   }
                }
              }

              if (html) {
                const { ticketNumber, subject, status, contactName: cName, address: addr, visitDate: vDate } = parseEmailHTML(html);
                if (ticketNumber && subject) {
                  const existing = tickets.find(t => t.ticketNumber === ticketNumber);
                  if (!existing) {
                    await addDoc(collection(db, 'tickets'), {
                      ticketNumber,
                      subject,
                      status: getStatusFromSubject(subject, status),
                      visitDate: vDate || null,
                      contactName: cName || null,
                      address: addr || null,
                      userId: user?.uid || 'SYSTEM',
                      createdAt: serverTimestamp(),
                      updatedAt: serverTimestamp(),
                    });
                    newCount++;
                  }
                }
              }
            }

            setSyncStatus(`Sync Complete! Found ${newCount} new tickets.`);
            setTimeout(() => setSyncStatus(null), 5000);
          } catch (error) {
            console.error(error);
            setSyncStatus('Sync Error: Failed to fetch Gmail data.');
          } finally {
            setIsSyncing(false);
          }
        },
      });
      client.requestAccessToken();
    } catch (error) {
      console.error(error);
      setSyncStatus('GIS Library Error.');
      setIsSyncing(false);
    }
  };

  const openEdit = (ticket: Ticket) => {
    setEditingTicket(ticket);
    setTicketNumber(ticket.ticketNumber);
    setSubject(ticket.subject);
    setVisitDate(ticket.visitDate || '');
    setContactName(ticket.contactName || '');
    setAddress(ticket.address || '');
    setIsAddOpen(true);
  };

  useEffect(() => {
    if (isAdmin && view === 'dashboard' && !isSyncing && tickets.length > 0) {
      const lastSync = localStorage.getItem('lastAutoSync');
      const now = Date.now();
      // Auto-sync once every 10 minutes session if possible
      if (!lastSync || now - parseInt(lastSync) > 600000) {
        syncGmail();
        localStorage.setItem('lastAutoSync', now.toString());
      }
    }
  }, [isAdmin, view]);

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

          <div className="p-8">
            <div className="flex border-b border-dash-border mb-8">
              <button 
                onClick={() => setLoginMode('admin')}
                className={cn(
                  "flex-1 pb-4 text-xs font-bold uppercase tracking-widest transition-all",
                  loginMode === 'admin' ? "text-dash-accent border-b-2 border-dash-accent" : "text-dash-muted"
                )}
              >
                Admin Access
              </button>
              <button 
                onClick={() => setLoginMode('viewer')}
                className={cn(
                  "flex-1 pb-4 text-xs font-bold uppercase tracking-widest transition-all",
                  loginMode === 'viewer' ? "text-dash-accent border-b-2 border-dash-accent" : "text-dash-muted"
                )}
              >
                View Only
              </button>
            </div>

            <AnimatePresence mode="wait">
              {loginMode === 'admin' ? (
                <motion.div 
                  key="admin"
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 10 }}
                  className="space-y-4"
                >
                  <p className="text-xs text-dash-muted text-center mb-6">Sign in with your corporate Google account to manage tickets and settings.</p>
                  <button 
                    onClick={loginWithGoogle}
                    className="w-full py-4 px-4 rounded-xl bg-dash-accent text-white font-bold hover:brightness-110 active:scale-[0.98] transition-all flex items-center justify-center gap-3 shadow-lg shadow-dash-accent/20"
                  >
                    Continue with Google
                  </button>
                </motion.div>
              ) : (
                <motion.div 
                  key="viewer"
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -10 }}
                  className="space-y-4"
                >
                  <p className="text-xs text-dash-muted text-center mb-6">Enter the access PIN provided by your administrator to view the dashboard.</p>
                  <div className="relative">
                    <input 
                      type="password"
                      placeholder="Enter 4-digit PIN"
                      maxLength={4}
                      className="w-full bg-dash-bg border border-dash-border rounded-xl px-4 py-4 text-center text-2xl tracking-[1em] font-bold focus:outline-none focus:ring-2 focus:ring-dash-accent/50 transition-all"
                      value={pin}
                      onChange={(e) => {
                        const val = e.target.value.replace(/\D/g, '');
                        setPin(val);
                        if (val === '7324') {
                          setIsViewer(true);
                        }
                      }}
                    />
                    {pin.length === 4 && pin !== '7324' && (
                      <p className="text-dash-accent text-[10px] font-bold text-center mt-2 uppercase">Invalid Access PIN</p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
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

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="hidden lg:flex w-72 bg-dash-card border-r border-dash-border p-6 flex-col gap-8">
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
            <button 
              onClick={syncGmail}
              disabled={isSyncing}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-dash-bg border border-dash-border hover:border-dash-accent transition-all group"
            >
              <RefreshCw size={14} className={cn("text-dash-accent transition-all", isSyncing && "animate-spin")} />
              <span>{isSyncing ? 'Synchronizing...' : 'Sync Gmail Logs'}</span>
            </button>
            {syncStatus && (
              <div className="mt-2 px-2 text-[9px] font-bold text-dash-accent animate-pulse uppercase tracking-tighter">
                {syncStatus}
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
                onClick={() => isAdmin ? handleLogout() : setIsViewer(false)}
                className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-dash-muted hover:text-dash-accent transition-colors"
              >
                <LogOut size={14} />
                {isAdmin ? 'Terminate Session' : 'Exit Viewer'}
              </button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col p-4 lg:p-8 gap-6 overflow-y-auto">
          {view === 'dashboard' ? (
            <>
              {/* Top Stats */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="bg-dash-card p-4 border border-dash-border rounded-xl shadow-sm">
                  <div className="text-[10px] text-dash-muted font-bold uppercase tracking-widest mb-1">Total Managed</div>
                  <div className="text-2xl font-bold">{stats.total}</div>
                </div>
                <div className="bg-dash-card p-4 border border-dash-border rounded-xl shadow-sm">
                  <div className="text-[10px] text-dash-muted font-bold uppercase tracking-widest mb-1 text-dash-accent">Critical Open</div>
                  <div className="text-2xl font-bold text-dash-accent">{stats.open.toString().padStart(2, '0')}</div>
                </div>
                <div className="bg-dash-card p-4 border border-dash-border rounded-xl shadow-sm">
                  <div className="text-[10px] text-dash-muted font-bold uppercase tracking-widest mb-1 text-dash-gold">In Transit</div>
                  <div className="text-2xl font-bold text-dash-gold">{stats.progress.toString().padStart(2, '0')}</div>
                </div>
                <div className="bg-dash-card p-4 border border-dash-border rounded-xl shadow-sm">
                  <div className="text-[10px] text-dash-muted font-bold uppercase tracking-widest mb-1 text-dash-secondary">Resolved</div>
                  <div className="text-2xl font-bold text-dash-secondary">{stats.done.toString().padStart(2, '0')}</div>
                </div>
              </div>

              {/* Controls */}
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="flex gap-2 items-center flex-wrap">
                  {['All', 'Open', 'In Progress', 'Visit Scheduled', 'Done'].map((st) => (
                    <button
                      key={st}
                      onClick={() => setStatusFilter(st as any)}
                      className={cn(
                        "px-3 py-1.5 text-[10px] font-bold border rounded transition-all uppercase tracking-wider",
                        statusFilter === st 
                          ? "bg-dash-border border-dash-muted text-dash-text" 
                          : "border-dash-border text-dash-muted hover:bg-dash-card"
                      )}
                    >
                      {st}
                    </button>
                  ))}
                </div>
                <div className="relative group max-w-sm w-full lg:w-72">
                  <Search size={14} className="absolute left-3 top-2.5 text-dash-muted group-focus-within:text-dash-accent transition-colors" />
                  <input 
                    type="text" 
                    placeholder="Search ticket or subject..." 
                    className="bg-dash-card border border-dash-border text-xs rounded px-10 py-2.5 w-full focus:outline-none focus:ring-1 focus:ring-dash-accent/50 transition-all"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>

              {/* Ticket Grid Table */}
              <div className="bg-dash-card border border-dash-border rounded-xl flex-1 flex flex-col overflow-hidden min-h-[400px]">
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="text-[10px] text-dash-muted uppercase tracking-widest border-b border-dash-border bg-dash-card/50">
                        <th className="px-6 py-4 font-bold">Ticket Number</th>
                        <th className="px-6 py-4 font-bold">Subject Line</th>
                        <th className="px-6 py-4 font-bold">Status</th>
                        <th className="px-6 py-4 font-bold text-right">Activity</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs divide-y divide-dash-border">
                      {ticketsLoading ? (
                        <tr>
                          <td colSpan={4} className="px-6 py-20 text-center">
                            <Loader2 className="w-6 h-6 animate-spin text-dash-muted mx-auto" />
                          </td>
                        </tr>
                      ) : filteredTickets.length === 0 ? (
                        <tr>
                          <td colSpan={4} className="px-6 py-20 text-center text-dash-muted italic">
                            No support tickets matching current filters.
                          </td>
                        </tr>
                      ) : (
                        filteredTickets.map((t) => {
                          const isTodayVisit = t.status === 'Visit Scheduled' && t.visitDate && isSameDay(new Date(t.visitDate), new Date());
                          return (
                            <tr 
                              key={t.id} 
                              onClick={() => openEdit(t)}
                              className={cn(
                                "hover:bg-dash-border/30 transition-colors cursor-pointer group",
                                isTodayVisit && "alert-active border-l-4 border-l-dash-accent"
                              )}
                            >
                              <td className="px-6 py-5 font-mono font-bold text-dash-muted group-hover:text-dash-text transition-colors">
                                #{t.ticketNumber}
                              </td>
                              <td className="px-6 py-5">
                                <div className="flex flex-col gap-0.5">
                                  <span className="text-dash-text font-medium text-sm line-clamp-1">{t.subject}</span>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    {t.contactName && (
                                      <span className="text-[10px] text-dash-muted font-bold uppercase tracking-wider">{t.contactName}</span>
                                    )}
                                    {t.address && (
                                      <>
                                        { t.contactName && <span className="text-dash-muted">•</span> }
                                        <span className="text-[10px] text-dash-muted italic">{t.address}</span>
                                      </>
                                    )}
                                  </div>
                                  {isTodayVisit && (
                                    <span className="text-[10px] text-rose-400 font-bold uppercase tracking-tight">Alert: Visit Scheduled for Today</span>
                                  )}
                                  {t.visitDate && !isTodayVisit && (
                                    <span className="text-[10px] text-rose-400 font-medium">Scheduled for: {t.visitDate}</span>
                                  )}
                                </div>
                              </td>
                              <td className="px-6 py-5">
                                <StatusBadge status={t.status} />
                              </td>
                              <td className="px-6 py-5 text-right">
                                <div className="flex items-center justify-end gap-3">
                                  <span className="text-[10px] text-dash-muted whitespace-nowrap hidden sm:inline">
                                    {t.updatedAt?.toDate ? format(t.updatedAt.toDate(), 'MMM d, p') : 'Recent'}
                                  </span>
                                  {isAdmin && (
                                    <button 
                                      onClick={(e) => handleDelete(t.id, e)}
                                      className="p-1 px-1.5 bg-dash-accent/10 text-dash-accent rounded opacity-0 group-hover:opacity-100 transition-all hover:bg-dash-accent hover:text-white"
                                    >
                                      <Trash2 size={12} />
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
                
                <div className="mt-auto p-4 border-t border-dash-border bg-dash-bg flex justify-between items-center text-[10px] text-dash-muted uppercase font-bold tracking-widest">
                  <span>Managed by Splendid System • {filteredTickets.length} items • {isAdmin ? 'ADMIN' : 'VIEWER'}</span>
                  <div className="flex items-center gap-4">
                    <span>Last sync: {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                </div>
              </div>
            </>
          ) : view === 'activity' ? (
            <div className="flex flex-col gap-8">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-black tracking-tight flex items-center gap-3">
                    <CalendarCheck className="text-dash-accent" />
                    Activity Board
                  </h2>
                  <p className="text-dash-muted text-xs font-bold uppercase tracking-widest mt-1">
                    Week of {format(selectedWeek.start, 'MMMM d')} - {format(selectedWeek.end, 'MMMM d, yyyy')}
                  </p>
                </div>
                <div className="flex items-center gap-1 bg-dash-card border border-dash-border p-1 rounded-lg">
                  <button onClick={() => setWeekOffset(v => v - 1)} className="p-2 hover:bg-dash-bg rounded transition-colors text-dash-muted">
                    <ChevronRight size={18} className="rotate-180" />
                  </button>
                  <button onClick={() => setWeekOffset(0)} className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest hover:text-dash-accent transition-colors">Current Week</button>
                  <button onClick={() => setWeekOffset(v => v + 1)} className="p-2 hover:bg-dash-bg rounded transition-colors text-dash-muted">
                    <ChevronRight size={18} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
                {/* Completed */}
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2 text-dash-secondary">
                    <CheckCircle2 size={18} />
                    <h3 className="text-xs font-black uppercase tracking-widest italic">Completed</h3>
                    <span className="ml-auto text-[10px] font-bold py-0.5 px-2 bg-dash-secondary/10 border border-dash-secondary/20 rounded-full">{activityGroups.completed.length}</span>
                  </div>
                  <div className="space-y-3">
                    {activityGroups.completed.map(t => (
                      <div key={t.id} className="bg-white border border-dash-border p-4 rounded-xl shadow-sm hover:shadow-md transition-all cursor-pointer group" onClick={() => openEdit(t)}>
                        <div className="text-[10px] font-mono text-dash-muted mb-1 font-bold">#{t.ticketNumber}</div>
                        <div className="font-bold text-sm leading-tight mb-2 group-hover:text-dash-accent transition-colors">{t.subject}</div>
                        <div className="text-[9px] text-dash-secondary font-black uppercase tracking-tighter">Ready for Monthly Record</div>
                      </div>
                    ))}
                    {activityGroups.completed.length === 0 && <p className="text-[10px] text-dash-muted italic px-2">No tickets completed this interval.</p>}
                  </div>
                </div>
 
                {/* Scheduled */}
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2 text-dash-accent">
                    <Calendar size={18} />
                    <h3 className="text-xs font-black uppercase tracking-widest italic">Scheduled</h3>
                    <span className="ml-auto text-[10px] font-bold py-0.5 px-2 bg-dash-accent/10 border border-dash-accent/20 rounded-full">{activityGroups.scheduled.length}</span>
                  </div>
                  <div className="space-y-3">
                    {activityGroups.scheduled.map(t => (
                      <div key={t.id} className="bg-white border border-dash-accent/20 p-4 rounded-xl shadow-sm hover:shadow-md transition-all border-l-4 border-l-dash-accent cursor-pointer group" onClick={() => openEdit(t)}>
                        <div className="text-[10px] font-mono text-dash-accent mb-1 font-black">VISIT: {t.visitDate}</div>
                        <div className="font-bold text-sm leading-tight mb-1 group-hover:text-dash-accent transition-colors">{t.subject}</div>
                        <div className="text-[10px] text-dash-muted uppercase font-bold">Ref #{t.ticketNumber}</div>
                      </div>
                    ))}
                    {activityGroups.scheduled.length === 0 && <p className="text-[10px] text-dash-muted italic px-2">No visits logged for this interval.</p>}
                  </div>
                </div>
 
                {/* Waiting */}
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2 text-dash-gold">
                    <Clock size={18} />
                    <h3 className="text-xs font-black uppercase tracking-widest italic">Waiting</h3>
                    <span className="ml-auto text-[10px] font-bold py-0.5 px-2 bg-dash-gold/10 border border-dash-gold/20 rounded-full">{activityGroups.waiting.length}</span>
                  </div>
                  <div className="space-y-3">
                    {activityGroups.waiting.map(t => (
                      <div key={t.id} className="bg-white border border-dash-border p-4 rounded-xl shadow-sm hover:shadow-md transition-all cursor-pointer group" onClick={() => openEdit(t)}>
                        <div className="text-[10px] font-mono text-dash-muted mb-1 font-bold">#{t.ticketNumber}</div>
                        <div className="font-bold text-sm leading-tight mb-2 group-hover:text-dash-accent transition-colors">{t.subject}</div>
                        <div className="flex items-center gap-2">
                           <div className="w-1.5 h-1.5 rounded-full bg-dash-gold animate-pulse"></div>
                           <span className="text-[9px] text-dash-gold font-black uppercase tracking-tighter">{t.status === 'In Progress' ? 'Pending Action' : 'In Review'}</span>
                        </div>
                      </div>
                    ))}
                    {activityGroups.waiting.length === 0 && <p className="text-[10px] text-dash-muted italic px-2">No active items in queue.</p>}
                  </div>
                </div>

                {/* Updated Log */}
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2 text-dash-accent">
                    <Plus size={18} />
                    <h3 className="text-xs font-bold uppercase tracking-widest">Recent Activity</h3>
                  </div>
                  <div className="bg-white border border-dash-border rounded-xl shadow-sm divide-y divide-dash-border overflow-hidden">
                    {activityGroups.updated.map(t => (
                      <div key={t.id} className="p-3 hover:bg-dash-bg transition-colors cursor-pointer" onClick={() => openEdit(t)}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[10px] font-bold text-dash-accent">#{t.ticketNumber}</span>
                          <span className="text-[9px] text-dash-muted uppercase font-bold">{t.updatedAt?.toDate ? format(t.updatedAt.toDate(), 'EEE p') : 'Just now'}</span>
                        </div>
                        <p className="text-xs text-dash-text line-clamp-1">{t.subject}</p>
                      </div>
                    ))}
                    {activityGroups.updated.length === 0 && <p className="p-4 text-[10px] text-dash-muted italic text-center">No recent updates logged.</p>}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-10 max-w-4xl">
              <div>
                <h2 className="text-2xl font-black tracking-tight flex items-center gap-3">
                  <FileText className="text-dash-accent" />
                  Annual Audit Reports
                </h2>
                <p className="text-dash-muted text-xs font-bold uppercase tracking-widest mt-1">
                  Generate comprehensive data extracts for compliance and tracking.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="bg-dash-card border border-dash-border p-8 rounded-2xl shadow-sm space-y-6">
                  <div className="w-12 h-12 bg-dash-accent/10 rounded-xl flex items-center justify-center text-dash-accent">
                    <Download size={24} />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg mb-1">CSV Performance Data</h3>
                    <p className="text-xs text-dash-muted leading-relaxed">
                      Export all ticket records, status transitions, and visit schedules into a structured CSV format. 
                      Ideal for monthly reporting or spreadsheet analysis.
                    </p>
                  </div>
                  <button 
                    onClick={exportToCSV}
                    className="w-full py-4 bg-dash-accent text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:brightness-110 transition-all shadow-lg shadow-dash-accent/20 flex items-center justify-center gap-3"
                  >
                    <Download size={16} />
                    Download Audit Report
                  </button>
                </div>

                <div className="bg-dash-card border border-dash-border p-8 rounded-2xl shadow-sm space-y-6">
                  <div className="w-12 h-12 bg-dash-gold/10 rounded-xl flex items-center justify-center text-dash-gold">
                    <Mail size={24} />
                  </div>
                  <div>
                    <h3 className="font-bold text-lg mb-1">Gmail Synchronization</h3>
                    <p className="text-xs text-dash-muted leading-relaxed">
                      Connect to your mailbox to automatically import tickets sent from support@splendidtechnology.com.
                      The system detects HTML payloads and maps them to secure tracking objects.
                    </p>
                  </div>
                  <button 
                    onClick={syncGmail}
                    disabled={isSyncing}
                    className="w-full py-4 bg-dash-gold text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:brightness-110 transition-all shadow-lg shadow-dash-gold/20 flex items-center justify-center gap-3 disabled:opacity-50"
                  >
                    <RefreshCw size={16} className={isSyncing ? "animate-spin" : ""} />
                    {isSyncing ? 'Syncing...' : 'Run Auto-Sync'}
                  </button>
                </div>
              </div>

              <div className="bg-dash-secondary/5 border border-dash-secondary/20 p-6 rounded-2xl">
                 <div className="flex items-center gap-3 mb-4 text-dash-secondary">
                   <AlertCircle size={18} />
                   <h4 className="text-[10px] font-black uppercase tracking-widest">Reporting Notice</h4>
                 </div>
                 <p className="text-[10px] text-dash-muted leading-relaxed uppercase font-bold tracking-tighter">
                   Audit reports are generated from the secure cloud database. 
                   Ensure all manual entries are finalized before exporting for accuracy. 
                   Data is retained for the current fiscal year.
                 </p>
              </div>
            </div>
          )}
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
                   <h2 className="text-xl font-bold tracking-tight">Ticket Details</h2>
                </div>
                <button onClick={() => setIsAddOpen(false)} className="p-2 bg-dash-border rounded hover:bg-dash-muted transition-colors text-dash-text">
                  <X size={18} />
                </button>
              </div>

              <form onSubmit={handleSaveTicket} className="space-y-6">
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Record Identifier</label>
                  <input 
                    required
                    readOnly
                    type="text" 
                    placeholder="Ticket Number (e.g. 12903)"
                    className="w-full bg-dash-bg border border-dash-border rounded px-4 py-3 outline-none focus:ring-1 focus:ring-dash-accent/50 transition-all font-mono text-sm opacity-70 cursor-not-allowed"
                    value={ticketNumber}
                    onChange={(e) => setTicketNumber(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Original Subject Context</label>
                  <textarea 
                    required
                    rows={4}
                    placeholder="Paste the email subject here..."
                    className="w-full bg-dash-bg border border-dash-border rounded px-4 py-3 outline-none focus:ring-1 focus:ring-dash-accent/50 transition-all resize-none text-sm leading-relaxed"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                  />
                  <div className="mt-2 p-3 rounded bg-dash-bg border border-dash-border">
                    <p className="text-[10px] text-dash-muted italic flex items-center gap-2">
                       <span className="w-1.5 h-1.5 rounded-full bg-dash-accent animate-pulse"></span>
                       Heuristic Classification: <span className="font-bold text-dash-text uppercase">{getStatusFromSubject(subject)}</span>
                    </p>
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Scheduled Intervention (Visits)</label>
                  <input 
                    type="date" 
                    className="w-full bg-dash-bg border border-dash-border rounded px-4 py-3 outline-none focus:ring-1 focus:ring-dash-accent/50 transition-all text-sm color-scheme-dark"
                    value={visitDate}
                    onChange={(e) => setVisitDate(e.target.value)}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Contact Name</label>
                    <input 
                      type="text" 
                      placeholder="e.g. John Doe"
                      className="w-full bg-dash-bg border border-dash-border rounded px-4 py-3 outline-none focus:ring-1 focus:ring-dash-accent/50 transition-all text-sm"
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-dash-muted mb-2">Campus Address</label>
                    <input 
                      type="text" 
                      placeholder="e.g. Building A"
                      className="w-full bg-dash-bg border border-dash-border rounded px-4 py-3 outline-none focus:ring-1 focus:ring-dash-accent/50 transition-all text-sm"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                    />
                  </div>
                </div>

                <div className="pt-6">
                  <button 
                    type="submit"
                    className="w-full bg-dash-accent py-3.5 rounded font-bold text-sm uppercase tracking-widest hover:brightness-110 transition-all shadow-xl shadow-dash-accent/20"
                  >
                    Save Changes
                  </button>
                  {editingTicket && (
                    <button 
                      type="button"
                      onClick={() => setIsAddOpen(false)}
                      className="w-full mt-3 py-3 text-[10px] font-bold uppercase tracking-widest text-dash-muted hover:text-dash-text transition-all"
                    >
                      Cancel Operation
                    </button>
                  )}
                </div>
              </form>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
