const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require('docx');
const fs = require('fs');

const heading = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 100 } });
const label = (text) => new Paragraph({ children: [new TextRun({ text, bold: true })], spacing: { before: 100, after: 50 } });
const item = (text) => new Paragraph({ text, bullet: { level: 0 }, spacing: { after: 40 } });

const doc = new Document({
  sections: [{
    properties: { page: { size: { width: 12240, height: 15840 } } },
    children: [
      new Paragraph({ text: 'CRM User Roles & Permissions Guide', heading: HeadingLevel.HEADING_1, spacing: { after: 200 } }),
      new Paragraph({ text: 'What you can do at each access level (L1 through L6). Updated 23 September 2026.', spacing: { after: 300 } }),

      heading('Words used in this guide'),
      item('Company (customer): an account in the CRM. Every company has exactly one location.'),
      item('Handler: a person who looks after a company. Handlers see everything about that company and own all of its cases.'),
      item('Assignee (ticket holder): the person currently working on one case.'),
      item('Direct: the name the CRM uses when a company has no real handler. Direct is not a person and gives nobody access.'),
      item('Your locations: the locations your admin gave you. They decide which other companies you can find.'),

      heading('L1 - Basic User'),
      label('You CAN:'),
      item('See your own dashboard'),
      item('Open and work on cases assigned to you: change the stage and set the outcome'),
      label('You CANNOT:'),
      item('Create companies, cases or quotations'),
      item('Search for or open companies'),
      item("See other people's dashboards"),

      heading('L2 - Sales'),
      label('Everything L1 can do, PLUS:'),
      item('Create companies. When you create one, you automatically become its handler.'),
      item('Open every company you handle, with its contacts, cases and quotations'),
      item('Find companies in your locations by name (you see the name only, not the details)'),
      item('Create cases on companies you handle. A case must always belong to a company.'),
      item('Create, upload and send quotations on companies you handle'),
      item('Edit the details and priority of companies you handle'),
      item('Add or remove handlers on companies you handle'),
      label('You CANNOT:'),
      item('Change a company\'s location, type or archive status (needs L3)'),
      item('Delete companies (needs L3)'),
      item("See other people's dashboards (needs L3)"),

      heading('L3 - Manager'),
      label('Everything L2 can do, PLUS:'),
      item('Open every company in your locations, even ones you do not handle'),
      item('Add or remove handlers on those companies'),
      item("Change a company's location, type and archive status"),
      item('Delete companies that have no cases and no quotations'),
      item('View the dashboards of L2 users who share one of your locations'),
      label('You CANNOT:'),
      item('Open companies outside your locations (you see the name only)'),
      item("View the Direct dashboard, or dashboards of L1, L3 or higher users (needs L4)"),

      heading('L4 - Senior Manager'),
      label('Everything L3 can do, PLUS:'),
      item('Open every company and every case, whatever the location'),
      item('View any active user\'s dashboard, and the Direct dashboard'),
      label('You CANNOT:'),
      item('Use the Admin area (needs L6)'),

      heading('L5 - Backend'),
      label('Same access as L4, with two differences:'),
      item('You can never be a handler. A company you create is handled by Direct until a handler is added.'),
      item('When you create a case, you must choose who it is assigned to.'),
      label('You CANNOT:'),
      item('Use the Admin area (needs L6)'),

      heading('L6 - Admin'),
      label('Everything L5 can do, PLUS the Admin area:'),
      item('Add and edit users, their level and their locations'),
      item('Edit the lists used across the CRM: locations, types, priorities, categories and more'),
      item('Bulk-add companies and run imports. Every company must be given exactly one location.'),
      item('Restore or permanently delete companies from the recycle bin'),
      label('Like L5, you can never be a handler.'),

      heading('Rules everyone should know'),
      item('Who owns a case: the handlers of its company. If the company has no real handler, Direct owns it, and only L4 and above (plus the assignee) can see it.'),
      item('Creating a company makes you its handler (L2 to L4). There is no opt-out; ask an L3 or above to move it to someone else afterwards.'),
      item('Removing the last handler of a company hands it to Direct. A company is never left with no owner.'),
      item('A company has exactly one location. A user can have many.'),
      item('An admin cannot take a location away from someone who still handles companies there. Those companies must first be given a new handler (another L2 to L4 user, or Direct).'),
      item('Need more access? Ask an L3 or above for a specific company, or the L6 admin for your level or locations.')
    ]
  }]
});

Packer.toBuffer(doc).then((buffer) => {
  fs.writeFileSync('role-guide-l1-l6.docx', buffer);
  console.log('Role guide created: role-guide-l1-l6.docx');
});
