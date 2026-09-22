/**
 * Pure reads, safe to serve once per request.
 *
 * Deliberately excluded and never to be added: `lockCase`/`lockCustomerName`
 * (SELECT ... FOR UPDATE, whose whole purpose is to hit the database), and
 * `nextCaseId`/`nextCustomerId`/`nextContactId` (counter increments).
 */
export const CASE_READ_METHODS = [
  'findCustomerByName',
  'getCase',
  'getCustomer',
  'getCustomersByIds',
  'latestHandover',
  'latestQuotedValueByCase',
  'listActivity',
  'listActivityByEntity',
  'listAttachmentsByCase',
  'listCases',
  'listHandlers',
  'listQuotesByCase',
  'listSettings',
  'listUsers'
] as const satisfies readonly string[];

export const CUSTOMER_READ_METHODS = [
  'countContactsByCustomer',
  'findCustomerByName',
  'getContact',
  'getCustomer',
  'getSetting',
  'hasCases',
  'hasQuotations',
  'listCasesByCustomer',
  'listContactsByCustomer',
  'listCustomers',
  'listHandlers',
  'listQuotesByCustomer',
  'listSettings',
  'listUsers'
] as const satisfies readonly string[];
