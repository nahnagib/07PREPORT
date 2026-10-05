# Testing the Debt Report locally

**Start:** double-click **`local-test.cmd`** in `C:\Users\Lenovo\Desktop\07PREPORT`. After about a minute an Edge
window opens on the Debt Report, already signed in as **Admin**.

**Another role:** run it from a terminal with the role name:

```powershell
.\local-test.cmd b2b
```

The roles are `admin`, `gceo`, `gcco`, `b2b` and `salesperson`. The salesperson should see "No access".

**Stop:** close the Edge window. If something stays open, double-click **`local-test-stop.cmd`**.

**What it does:**

- It runs the code in `07PREPORT`, with your uncommitted changes.
- It **only reads** `powerBI_Data`: the test server refuses every change, and it doesn't start Docker, the ETL,
  Redis or any schedule. No `.env` and no setting is changed.
- **Needs:** the MySQL service running (it normally is).

**If it fails:**

| Message | Fix |
|---|---|
| "Port … is already in use" | double-click `local-test-stop.cmd`, then try again |
| "The API did not start" | start the MySQL service, then try again |
| "The frontend did not start" | wait and try again; the logs are in `%TEMP%\07ps-local-test-*.log` |
