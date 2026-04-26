import { useState, useEffect } from 'react';
import { onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { auth, db, Ticket, handleFirestoreError, OperationType } from './firebase';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      setUser(user);
      setLoading(false);
    });
  }, []);

  return { user, loading };
}

export function useTickets(userId: string | undefined) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) {
      setTickets([]);
      setLoading(false);
      return;
    }

    const q = userId === 'ALL' 
      ? query(collection(db, 'tickets'), orderBy('createdAt', 'desc'))
      : query(
          collection(db, 'tickets'),
          where('userId', '==', userId),
          orderBy('createdAt', 'desc')
        );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs
        .map(doc => ({
          id: doc.id,
          ...doc.data()
        })) as Ticket[];
      
      setTickets(docs);
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'tickets');
      setLoading(false);
    });

    return () => unsubscribe();
  }, [userId]);

  return { tickets, loading };
}
