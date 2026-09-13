import { parseContactIds, withStore } from "./shared.js";

withStore((store) => {
  const contacts = store.reviewContacts(parseContactIds(process.argv.slice(2)), "APPROVED");
  console.log(
    `Approved ${contacts.length} ${contacts.length === 1 ? "contact" : "contacts"}: `
    + contacts.map(({ id }) => id).join(", "),
  );
});
