# Docker Commands — Recruitment Pipeline 🐳

> Run all commands from the project root folder (`recruitment-pipeline/`)

---

## 1️⃣ First Time Setup (Build + Start Everything)

```bash
docker compose up --build
```

This **builds** images for backend & frontend, pulls Postgres, and **starts all 3 services**.

Your app will be live at:

- **Frontend** → http://localhost:3001
- **Backend API** → http://localhost:3000
- **Database** → localhost:5432

---

## 2️⃣ Start (Without Rebuilding)

```bash
docker compose up
```

Use this when you **haven't changed any code** — just want to start the app again.

---

## 3️⃣ After You Change Code → Rebuild & Restart

```bash
docker compose up --build
```

Same as step 1. The `--build` flag tells Docker to **rebuild** the images with your new code.

> Docker caches layers, so only the changed parts rebuild — it's fast after the first time.

---

## 4️⃣ Stop Everything

```bash
docker compose down
```

Stops and removes all containers. **Your database data is safe** (it's in a named volume).

---

## 5️⃣ Stop + Delete Database Data (Fresh Start)

```bash
docker compose down -v
```

The `-v` flag **removes volumes** too — this wipes your database. Use when you want a completely clean slate.

---

## 6️⃣ Run in Background (Detached Mode)

```bash
docker compose up --build -d
```

The `-d` flag runs everything in the **background** so your terminal stays free.

---

## 7️⃣ Check Running Containers

```bash
docker compose ps
```

---

## 8️⃣ See Logs

```bash
docker compose logs            # all services
docker compose logs backend    # only backend
docker compose logs -f         # follow live (like tail -f)
```

---

## 9️⃣ View Database Data (Prisma Studio)

To inspect and edit Docker's database at `http://localhost:51212`:

```bash
cd backend
npm run db:studio
```

Prisma Studio will open:
👉 **`http://localhost:51212/#schema=public&table=User&view=table`**

*(Note: Docker PostgreSQL is exposed on host port `5433` in `docker-compose.yml`, and `backend/.env` is configured with `localhost:5433` so it never conflicts with local Windows PostgreSQL on `5432`)*

---

## Quick Reference

| What you want to do       | Command                       |
| ------------------------- | ----------------------------- |
| Build & start everything  | `docker compose up --build`   |
| Start without rebuilding  | `docker compose up`           |
| Stop everything           | `docker compose down`         |
| Stop + wipe database      | `docker compose down -v`      |
| Run in background         | `docker compose up --build -d`|
| Check status              | `docker compose ps`           |
| View logs                 | `docker compose logs -f`      |
| **View DB data (Studio)** | `npm run db:studio` (in `backend/`) |
