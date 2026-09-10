# أثر HR — Simple Backend

نظام موارد بشرية مبسّط يعمل مباشرة على Render.

## بنية المشروع

```
backend/
├── index.js              # كل الـ endpoints في ملف واحد
├── prisma/
│   ├── schema.prisma     # قاعدة البيانات
│   └── seed.js           # ينشئ حساب الأدمن
├── package.json
└── .gitignore
```

## النشر على Render

### 1. اربط GitHub
- New → Web Service
- Root Directory: `backend`
- Language: **Node**
- Build Command:
  ```
  npm install && npx prisma migrate deploy && npm run seed
  ```
- Start Command: `npm start`
- Plan: Free

### 2. Environment Variables

المطلوبة:
- `DATABASE_URL` — Neon Pooled Connection String
- `JWT_SECRET` — نص عشوائي طويل (48+ حرف)
- `ADMIN_EMAIL` — إيميلك
- `ADMIN_PASSWORD` — باسورد قوي
- `PORT` — 4000

اختيارية (لتخزين الصور في Supabase):
- `STORAGE_ENDPOINT`
- `STORAGE_ACCESS_KEY`
- `STORAGE_SECRET_KEY`
- `STORAGE_BUCKET`
- `STORAGE_PUBLIC_URL`

## بعد النشر

- سجّل دخول بـ `ADMIN_EMAIL` و `ADMIN_PASSWORD`
- أضف فروعك من `/api/branches`
- أضف موظفينك من `/api/employees`
- الموظفين يستخدمون employeeNumber + PIN للدخول

## المسارات المتاحة

### Auth
- `POST /api/auth/login` — دخول أدمن
- `POST /api/auth/login-pin` — دخول موظف
- `GET /api/auth/me` — معلوماتي

### Branches
- `GET /api/branches`
- `POST /api/branches`
- `PATCH /api/branches/:id`

### Employees
- `GET /api/employees`
- `POST /api/employees`
- `PATCH /api/employees/:id`

### Attendance
- `POST /api/attendance/clock` — بصمة (بصورة + GPS)
- `GET /api/attendance/my` — سجلي
- `GET /api/attendance/today` — بصمات اليوم

### Requests
- `POST /api/requests`
- `GET /api/requests/my`
- `GET /api/requests/pending`
- `POST /api/requests/:id/approve`
- `POST /api/requests/:id/reject`

### Dashboard
- `GET /api/dashboard/kpis`
