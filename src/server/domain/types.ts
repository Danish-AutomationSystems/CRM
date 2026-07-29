export type CustomerRecord = {
  id: string;
  name: string;
  tags: readonly string[] | string;
  type?: string;
};

export type CaseRecord = {
  id: string;
  customerId: string;
  title: string;
  owner: string;
  extraOwners: readonly string[] | string;
  assignee: string;
};

export type AccessOwnership = {
  handlerEmailsByCustomerId: Record<string, readonly string[]>;
  assigneeEmailsByCustomerId?: Record<string, readonly string[]>;
  extraOwnerEmailsByCustomerId?: Record<string, readonly string[]>;
};

export type CustomerAccessLevel = 'FULL' | 'NAME' | 'NONE';
