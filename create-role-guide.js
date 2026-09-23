// Generates role-guide-l1-l6.docx, the plain-language staff guide.
// Every bullet carries `src`: the code that makes the statement true. It is not printed in the
// document; it is here so any future edit can be re-checked against the code it cites.
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
const fs = require('fs');

const heading = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 } });
const label = (text) => new Paragraph({ children: [new TextRun({ text, bold: true })], spacing: { before: 100, after: 50 } });
const item = (text, src) => {
  if (!src) throw new Error(`No evidence recorded for: ${text}`);
  return new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 40 } });
};

const doc = new Document({
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 } } },
    children: [
      new Paragraph({ text: 'CRM User Roles & Permissions Guide', heading: HeadingLevel.HEADING_1, spacing: { after: 200 } }),
      new Paragraph({ text: 'What you can do at each access level (L1 through L6). Checked against the live CRM on 23 September 2026.', spacing: { after: 300 } }),

      heading('Words used in this guide'),
      item('Company (customer): an account in the CRM. Every company has exactly one location.',
        'domain/locations.ts requireSingleLocation; migration 0016 customers_single_location_check'),
      item('Handler: a person who looks after a company. Handlers can open everything about that company and own all of its cases.',
        'auth/access.ts accessLevel (handler -> FULL, line 39-40); caseHandlers (line 67-70)'),
      item('Assignee (ticket holder): the person currently working on one case.',
        'cases.assignee; auth/access.ts caseVisible line 82'),
      item('Direct: the name the CRM uses when a company has no real handler. Direct is not a person and gives nobody access.',
        'domain/direct.ts (virtual, no users row); auth/access.ts caseHandlers line 69'),
      item('Your locations: the locations your admin gave you. For L2 and L3 they decide which other companies you can find and open.',
        'auth/access.ts accessLevel lines 45-46 (tag match only consulted for L2/L3)'),

      heading('L1 - Basic User'),
      label('You CAN:'),
      item('See "My work": the tickets assigned to you',
        'Index.html renderL1Dash line 667'),
      item('Open cases assigned to you, edit them, change the stage, mark them Won, Lost or On hold, and reassign the ticket to someone else',
        'auth/access.ts caseVisible line 82; cases/service.ts getCase canEdit:true line 1041, canAssignTicket line 1043; updateCase line 688 (visibility only)'),
      label('You CANNOT:'),
      item('Create companies, cases or quotations',
        'customers/service.ts:602, cases/service.ts createCase + quickLog requireLevel(2), quotes/service.ts:480,573; Index.html:540 quick-log button L2+'),
      item('Search for companies',
        'customers/service.ts searchCustomers requireLevel(2) line 464'),
      item('Open a company, unless someone makes you its handler (then you can open it fully)',
        'auth/access.ts accessLevel: L1 returns NONE (line 47) unless handler (line 39-40); customers/service.ts addHandler only refuses L5/L6 (line 912)'),
      item("See other people's dashboards",
        'dashboard/service.ts line 317'),

      heading('L2 - Sales'),
      label('Everything L1 can do, PLUS:'),
      item('Create companies. When you create one, you automatically become its handler.',
        'customers/service.ts createCustomer requireLevel(2) line 602 + creatorHandlerEmail line 204-206; cases/service.ts quickLog new customer'),
      item('Open every company you handle, with its contacts, cases and quotations',
        'auth/access.ts line 39-40 (handler -> FULL); customers/service.ts getCustomer FULL branch'),
      item('Find companies in your locations by name. You see only basic facts (name, location, type, priority, handlers), not contacts, cases or quotations.',
        'auth/access.ts line 46 (L2 tag match -> NAME); customers/service.ts getCustomer NAME branch line 564'),
      item('Create cases on companies you handle. Every case must belong to a company.',
        'cases/service.ts createCase requireLevel(2) + ensureFull; line 618 "Select a company"; migration 0018 NOT NULL'),
      item('Create, upload and send quotations on companies you handle',
        'quotes/service.ts requireLevel(2) lines 480, 573 + ensureFull; setQuoteStatus FULL only'),
      item('Edit the details and priority of companies you handle',
        'customers/service.ts updateCustomer ensureFull + priority requireLevel(2) line 402'),
      item('Add or remove handlers on companies you handle',
        'customers/service.ts addHandler line 899-900, removeHandler line 944-945 (existing handler allowed)'),
      label('You CANNOT:'),
      item("Change a company's location, type or archive status (needs L3)",
        'customers/service.ts line 408-409'),
      item('Delete companies (needs L3)',
        'customers/service.ts deleteCustomers requireLevel(3) line 978'),
      item("See other people's dashboards (needs L3)",
        'dashboard/service.ts line 317'),

      heading('L3 - Manager'),
      label('Everything L2 can do, PLUS:'),
      item('Open every company in your locations, even ones you do not handle, with their cases',
        'auth/access.ts line 45 (L3 tag match -> FULL); caseVisible line 79 (FULL customer access sees its cases)'),
      item('On any company you can open: add or remove handlers, and change its location, type and archive status',
        'customers/service.ts addHandler/removeHandler L3+ bypass lines 899, 944; Index.html:1174 button only in FULL view; updateCustomer line 408'),
      item('Delete companies you can open that have no cases and no quotations',
        'customers/service.ts deleteCustomers requireLevel(3) line 978, per-row ensureFull, skip "has cases/quotations" line 1000'),
      item('View the dashboards of L2 users who share one of your locations',
        'dashboard/service.ts lines 320-322'),
      label('You CANNOT:'),
      item('Open companies outside your locations that you do not handle (you see only basic facts)',
        'auth/access.ts line 45 (no tag match -> NAME)'),
      item('View the Direct dashboard, or the dashboards of L1, L3 or higher users (needs L4)',
        'dashboard/service.ts line 305 + direct.ts:28 (Direct needs L4); line 321 (L3 sees L2 only)'),

      heading('L4 - Senior Manager'),
      label('Everything L3 can do, PLUS:'),
      item('Open every company and every case, whatever the location',
        'auth/access.ts seesAll line 37; caseVisible seesAll'),
      item("View any active user's dashboard, and the Direct dashboard",
        'dashboard/service.ts lines 305, 318-320 (L4 skips L3 restrictions)'),
      item('Be a handler. A company you create is yours to handle.',
        'customers/service.ts creatorHandlerEmail line 205 (only L5/L6 -> Direct); admin ELIGIBLE_HANDLER_ROLES line 352'),
      label('You CANNOT:'),
      item('Use the Admin area (needs L6)',
        'auth/access.ts ensureAdmin line 114; Index.html isAdmin line 496'),

      heading('L5 - Backend'),
      label('Same access as L4, with these differences:'),
      item('Your home page is an Overview with no personal sales figures. Pick a user there to see their dashboard.',
        'Index.html renderBackendDash line 611-613'),
      item('You can never be a handler. A company you create is handled by Direct until a handler is added.',
        'customers/service.ts creatorHandlerEmail line 204-206, addHandler refuses L5/L6 line 912'),
      item('When you create a case from a company page, you must choose who it is assigned to (a won order needs no assignee). A quick-logged case is assigned to you.',
        'cases/service.ts createCase line 648-649 (order branch line 642); quickLog assignee line 1234'),
      label('You CANNOT:'),
      item('Use the Admin area (needs L6)',
        'auth/access.ts ensureAdmin line 114'),

      heading('L6 - Admin'),
      label('Everything L5 can do, PLUS the Admin area:'),
      item('Add and edit users, their level and their locations',
        'admin/service.ts saveUser ensureAdmin line 697-698'),
      item('Edit the lists used across the CRM: locations, types, priorities, categories and more',
        'admin/service.ts CONFIGURABLE_KEYS line 433, saveSettings ensureAdmin'),
      item('Bulk-add companies and run imports. Every company must be given exactly one location.',
        'Index.html Admin bulk form (isAdmin); admin/service.ts runImport ensureAdmin line 1008; requireSingleLocation'),
      item('Restore or permanently delete companies from the recycle bin',
        'admin/service.ts restoreCustomer line 1200, purgeCustomer line 1226, both ensureAdmin'),
      label('Like L5, you can never be a handler, and your home page is the Overview.'),

      heading('Rules everyone should know'),
      item('Who owns a case: the handlers of its company. If the company has no real handler, Direct owns it. Direct is not a person, so such a case is seen only by L4 and above, L3 users in that location, and its assignee.',
        'auth/access.ts caseHandlers line 69, caseVisible lines 77-83, accessLevel line 45'),
      item('Creating a company makes you its handler (L2 to L4). To hand it over, add the new handler and then remove yourself, or ask an L3 or above.',
        'customers/service.ts creatorHandlerEmail; addHandler/removeHandler existing-handler gate lines 899, 944'),
      item('Removing the last handler of a company hands it to Direct. A company is never left without an owner.',
        'customers/service.ts removeHandler line 957; migration 0015'),
      item('A company has exactly one location. A user can have many.',
        'domain/locations.ts; migration 0016; users.allowed_tags is an array with no such check'),
      item('A case cannot exist without a company.',
        'cases/service.ts line 618; quotes/service.ts auto-case guard; migration 0018 customer_id NOT NULL'),
      item('An admin cannot take a location away from someone who still handles companies there. Each of those companies must first be given a new handler: another active L2 to L4 user, or Direct.',
        'admin/service.ts saveUser conflict check line 726, assertValidReplacementHandler, ELIGIBLE_HANDLER_ROLES line 352'),
      item('Need more access to a company? Ask one of its handlers or an L3 or above to add you as a handler. For a new level or new locations, ask the L6 admin.',
        'addHandler gate lines 899-900; saveUser ensureAdmin')
    ]
  }]
});

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync('role-guide-l1-l6.docx', buffer);
  console.log('Role guide created: role-guide-l1-l6.docx');
});
