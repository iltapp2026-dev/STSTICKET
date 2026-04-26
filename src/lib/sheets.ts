import { getGmailToken, Ticket } from './firebase';

// NOTE: This ID should be replaced with the actual Google Sheet ID
const SPREADSHEET_ID_KEY = 'sts_spreadsheet_id';
const DEFAULT_SPREADSHEET_ID = '1_oA8c_bI86v9Vv_Noa-u8n6X5Y6vXz0n5n-n5n5n5n';

export const getSpreadsheetId = () => {
  return localStorage.getItem(SPREADSHEET_ID_KEY) || DEFAULT_SPREADSHEET_ID;
};

export const setSpreadsheetId = (id: string) => {
  localStorage.setItem(SPREADSHEET_ID_KEY, id);
};

export interface SheetTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  status: string;
  visitDate: string;
  contactName: string;
  address: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  archived: string;
  brief: string;
}

export async function fetchAllTicketsFromSheets(): Promise<SheetTicket[]> {
  const spreadsheetId = getSpreadsheetId();
  if (spreadsheetId === DEFAULT_SPREADSHEET_ID) {
    console.warn("Using default spreadsheet ID. Please configure your actual Google Sheet ID.");
    return [];
  }

  try {
    const token = await getGmailToken();
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Tickets!A2:L`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        // Sheet might not exist, create it?
        await initializeSheet();
        return [];
      }
      throw new Error(`Failed to fetch from sheets: ${response.statusText}`);
    }

    const data = await response.json();
    const rows = data.values || [];
    
    return rows.map((row: any[]) => ({
      id: row[0] || '',
      ticketNumber: row[1] || '',
      subject: row[2] || '',
      status: row[3] || '',
      visitDate: row[4] || '',
      contactName: row[5] || '',
      address: row[6] || '',
      userId: row[7] || '',
      createdAt: row[8] || '',
      updatedAt: row[9] || '',
      archived: row[10] || '',
      brief: row[11] || '',
    }));
  } catch (error) {
    console.error("Error fetching from sheets:", error);
    return [];
  }
}

export async function initializeSheet() {
  const spreadsheetId = getSpreadsheetId();
  const token = await getGmailToken();
  
  // Try to create the "Tickets" sheet
  const headers = [
    'ID', 'Ticket Number', 'Subject', 'Status', 'Visit Date', 'Contact Name', 
    'Address', 'User ID', 'Created At', 'Updated At', 'Archived', 'Brief'
  ];

  try {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title: 'Tickets'
              }
            }
          }
        ]
      })
    });
  } catch (e) {
    // Might already exist
  }

  // Set headers
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Tickets!A1:L1?valueInputOption=RAW`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      values: [headers]
    })
  });
}

export async function syncTicketToSheets(ticket: Ticket) {
  const spreadsheetId = getSpreadsheetId();
  const token = await getGmailToken();

  const row = [
    ticket.id,
    ticket.ticketNumber,
    ticket.subject,
    ticket.status,
    ticket.visitDate || '',
    ticket.contactName || '',
    ticket.address || '',
    ticket.userId || 'system',
    ticket.createdAt?.toDate ? ticket.createdAt.toDate().toISOString() : new Date().toISOString(),
    ticket.updatedAt?.toDate ? ticket.updatedAt.toDate().toISOString() : new Date().toISOString(),
    ticket.archived ? 'TRUE' : 'FALSE',
    ticket.brief || ''
  ];

  // 1. Find if ticket exists
  const tickets = await fetchAllTicketsFromSheets();
  const rowIndex = tickets.findIndex(t => t.id === ticket.id);

  if (rowIndex !== -1) {
    // Update existing row (A2:L is the range, so index 0 is row 2)
    const range = `Tickets!A${rowIndex + 2}:L${rowIndex + 2}`;
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: [row]
      })
    });
  } else {
    // Append new row
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Tickets!A:L:append?valueInputOption=RAW`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: [row]
      })
    });
  }
}

export async function deleteTicketFromSheets(ticketId: string) {
  const spreadsheetId = getSpreadsheetId();
  const token = await getGmailToken();

  const tickets = await fetchAllTicketsFromSheets();
  const rowIndex = tickets.findIndex(t => t.id === ticketId);

  if (rowIndex !== -1) {
     // Sheets doesn't have a simple "delete row by index" via values API easily without batchUpdate
     // We'll just clear the row or mark as deleted
     const range = `Tickets!A${rowIndex + 2}:L${rowIndex + 2}`;
     await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:clear`, {
       method: 'POST',
       headers: {
         'Authorization': `Bearer ${token}`
       }
     });
  }
}
