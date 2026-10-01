/** Permission catalogue and the default roles every new workspace gets. */
export const PERMISSIONS = {
  'chats.view': 'See conversations assigned to them or unassigned',
  'chats.view_all': 'See every conversation, including ones assigned to others',
  'chats.reply': 'Reply to visitors and write internal notes',
  'chats.assign': 'Assign conversations to teammates',
  'chats.close': 'Close and reopen conversations',
  'chats.delete': 'Delete conversations permanently',
  'chats.block': 'Block visitors, report spam and manage spam protection',
  'contacts.view': 'View contacts',
  'contacts.edit': 'Edit contacts and notes',
  'contacts.export': 'Export contacts and transcripts',
  'tickets.view': 'See tickets assigned to them or unassigned',
  'tickets.view_all': 'See every ticket',
  'tickets.reply': 'Create tickets, reply to customers and write internal notes',
  'tickets.manage': 'Delete and merge tickets, edit ticket SLAs and fields',
  'canned.manage': 'Create and delete saved replies',
  'bot.manage': 'Edit chatbot rules, flows, knowledge base and triggers',
  'settings.manage': 'Change widget, email, hours and webhook settings',
  'sites.manage': 'Add, rename and delete websites',
  'team.manage': 'Invite, edit and remove teammates',
  'roles.manage': 'Create and edit roles',
  'analytics.view': 'View reports and analytics',
  'audit.view': 'View the audit log',
  'workspace.manage': 'Rename the workspace',
  'billing.manage': 'Change the plan, pay and download invoices',
};
export const ALL = Object.keys(PERMISSIONS);

/** Ticket permissions per default role; also used to upgrade roles created before tickets existed. */
export const TICKET_DEFAULTS = {
  Admin: ['tickets.view', 'tickets.view_all', 'tickets.reply', 'tickets.manage'], Supervisor: ['tickets.view', 'tickets.view_all', 'tickets.reply', 'tickets.manage'],
  Agent: ['tickets.view', 'tickets.reply'], Viewer: ['tickets.view', 'tickets.view_all'],
};

export const DEFAULT_ROLES = [
  { name: 'Owner', system: 1, permissions: ALL },
  { name: 'Admin', system: 0, permissions: ALL.filter(p => p !== 'workspace.manage') },
  { name: 'Supervisor', system: 0, permissions: ['chats.view', 'chats.view_all', 'chats.reply', 'chats.assign', 'chats.close', 'chats.block', 'contacts.view', 'contacts.edit', 'contacts.export', 'canned.manage', 'bot.manage', 'analytics.view', ...TICKET_DEFAULTS.Supervisor] },
  { name: 'Agent', system: 0, permissions: ['chats.view', 'chats.reply', 'chats.close', 'chats.block', 'contacts.view', 'contacts.edit', ...TICKET_DEFAULTS.Agent] },
  { name: 'Viewer', system: 0, permissions: ['chats.view', 'chats.view_all', 'contacts.view', 'analytics.view', ...TICKET_DEFAULTS.Viewer] },
];

export const cleanPerms = list => [...new Set((Array.isArray(list) ? list : []).filter(p => ALL.includes(p)))];
