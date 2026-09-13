import { parseContactIds, withStore } from "./shared.js";

withStore((store) => {
  const contacts = store.reviewContacts(parseContactIds(process.argv.slice(2)), "REJECTED");
  console.log(
    `Rejected ${contacts.length} ${contacts.length === 1 ? "contact" : "contacts"}: `
    + contacts.map(({ id }) => id).join(", "),
  );
});
