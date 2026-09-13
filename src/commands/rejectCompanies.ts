import { parseCompanyIds, withStore } from "./shared.js";

withStore((store) => {
  const companies = store.reviewCompanies(parseCompanyIds(process.argv.slice(2)), "REJECTED");
  console.log(`Rejected ${companies.length} ${companies.length === 1 ? "company" : "companies"}: ${companies.map(({ id }) => id).join(", ")}`);
});
