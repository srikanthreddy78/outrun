/**
 * A live check of Naive's CRM: creates a throwaway contact, moves its stage, logs a note,
 * finds it by email, reads it back, deletes it and confirms it's gone. Then reports how many
 * prospects are in the CRM and that none is duplicated.
 *
 *   pnpm --filter @outrun/user-acquisition crm:check
 */
import {
  addNote,
  clientFromEnv,
  createContact,
  deleteContact,
  findContactByEmail,
  getContact,
  listContacts,
  NaiveApiError,
  updateContact,
} from "./naive-api.ts";

const client = clientFromEnv(process.env);
const failures: string[] = [];
const expect = (ok: boolean, what: string): void => {
  console.log(`${ok ? "pass" : "FAIL"}  ${what}`);
  if (!ok) failures.push(what);
};

const email = `crm-check-${Date.now()}@example.com`;
const contact = await createContact(
  client,
  { name: "CRM check", company: "Outrun check", email, stage: "lead", source: "crm-check" },
  `outrun-crm-check-${email}`,
);
try {
  expect(contact.stage === "lead", "create: a new contact starts as a lead");
  const moved = await updateContact(client, contact.id, {
    stage: "talking",
    next_step: "Reply to the check",
  });
  expect(
    moved.stage === "talking" && moved.next_step === "Reply to the check",
    "update: stage and next step change",
  );
  await addNote(client, contact.id, "CRM check note", `outrun-crm-check-note-${email}`);
  const found = await findContactByEmail(client, email);
  expect(found?.id === contact.id, "search: the contact is found by email");
  const read = await getContact(client, contact.id);
  expect(
    read.activity.some((entry) => entry.body === "CRM check note"),
    "activity: the note is on the contact",
  );
} finally {
  await deleteContact(client, contact.id);
}
const gone = await getContact(client, contact.id).then(
  () => false,
  (error: unknown) => error instanceof NaiveApiError && error.status === 404,
);
expect(gone, "delete: the contact is gone");

const prospects = (await listContacts(client)).filter((row) => row.source?.startsWith("prospector:"));
const emails = prospects.map((row) => row.email?.toLowerCase() ?? "");
expect(new Set(emails).size === emails.length, `no duplicates among ${prospects.length} prospect contacts`);
const stages = prospects.reduce<Record<string, number>>((count, row) => {
  count[row.stage] = (count[row.stage] ?? 0) + 1;
  return count;
}, {});
console.log(`prospect contacts by stage: ${JSON.stringify(stages)}`);

if (failures.length > 0) {
  console.error(`${failures.length} check(s) failed`);
  process.exitCode = 1;
}
