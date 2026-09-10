// ═══════════════════════════════════════════════════════
//  أثر HR — Simple Node.js Backend
//  ملف واحد يحتوي كل الـ endpoints
// ═══════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const prisma = new PrismaClient();
const app = express();

// ═══════════════════ CONFIG ═══════════════════
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

// ═══════════════════ MIDDLEWARE ═══════════════════
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ═══════════════════ AUTH MIDDLEWARE ═══════════════════
const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول' });
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'جلسة منتهية' });
  }
};

// ═══════════════════ S3 STORAGE ═══════════════════
let s3Client = null;
function getS3() {
  if (!s3Client && process.env.STORAGE_ENDPOINT) {
    s3Client = new S3Client({
      region: 'auto',
      endpoint: process.env.STORAGE_ENDPOINT,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY,
        secretAccessKey: process.env.STORAGE_SECRET_KEY,
      },
      forcePathStyle: true,
    });
  }
  return s3Client;
}

async function uploadPhoto(buffer, key) {
  const client = getS3();
  if (!client) {
    // Dev fallback: base64
    return `data:image/jpeg;base64,${buffer.toString('base64')}`;
  }
  await client.send(new PutObjectCommand({
    Bucket: process.env.STORAGE_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'image/jpeg',
  }));
  return `${process.env.STORAGE_PUBLIC_URL}/${key}`;
}

// ═══════════════════ GEOFENCE ═══════════════════
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ═══════════════════ HEALTH ═══════════════════
app.get('/', (req, res) => res.json({ ok: true, service: 'athr-hr' }));
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ═══════════════════ AUTH ROUTES ═══════════════════
// Admin login (email + password)
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'البيانات ناقصة' });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) return res.status(401).json({ error: 'بيانات غير صحيحة' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'بيانات غير صحيحة' });

    const token = jwt.sign({ userId: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ داخلي' });
  }
});

// Employee login (employeeNumber + PIN)
app.post('/api/auth/login-pin', async (req, res) => {
  try {
    const { employeeNumber, pin } = req.body;
    if (!employeeNumber || !pin) return res.status(400).json({ error: 'البيانات ناقصة' });

    const employee = await prisma.employee.findUnique({
      where: { employeeNumber },
      include: { user: true, branch: true },
    });
    if (!employee || !employee.user || !employee.user.pin) {
      return res.status(401).json({ error: 'بيانات غير صحيحة' });
    }

    const valid = await bcrypt.compare(pin, employee.user.pin);
    if (!valid) return res.status(401).json({ error: 'الرمز غير صحيح' });

    const token = jwt.sign(
      { userId: employee.user.id, employeeId: employee.id, role: 'EMPLOYEE' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      token,
      employee: {
        id: employee.id,
        employeeNumber: employee.employeeNumber,
        nameAr: employee.nameAr,
        position: employee.position,
        branch: {
          id: employee.branch.id,
          nameAr: employee.branch.nameAr,
          latitude: employee.branch.latitude,
          longitude: employee.branch.longitude,
          geofenceRadius: employee.branch.geofenceRadius,
        },
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'خطأ داخلي' });
  }
});

app.get('/api/auth/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.userId },
    include: { employee: { include: { branch: true } } },
  });
  res.json(user);
});

// ═══════════════════ BRANCHES ═══════════════════
app.get('/api/branches', authenticate, async (req, res) => {
  const branches = await prisma.branch.findMany({
    where: { active: true },
    include: { _count: { select: { employees: true } } },
  });
  res.json({ data: branches });
});

app.post('/api/branches', authenticate, async (req, res) => {
  try {
    const { code, nameAr, city, latitude, longitude, geofenceRadius } = req.body;
    if (!code || !nameAr || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'البيانات ناقصة' });
    }
    const branch = await prisma.branch.create({
      data: {
        code, nameAr, city,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        geofenceRadius: parseInt(geofenceRadius || 100),
      },
    });
    res.status(201).json(branch);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/branches/:id', authenticate, async (req, res) => {
  try {
    const branch = await prisma.branch.update({
      where: { id: req.params.id },
      data: req.body,
    });
    res.json(branch);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/branches/:id', authenticate, async (req, res) => {
  try {
    await prisma.branch.update({
      where: { id: req.params.id },
      data: { active: false },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════ EMPLOYEES ═══════════════════
app.get('/api/employees', authenticate, async (req, res) => {
  const { branchId, search } = req.query;
  const where = {};
  if (branchId) where.branchId = branchId;
  if (search) {
    where.OR = [
      { nameAr: { contains: search, mode: 'insensitive' } },
      { employeeNumber: { contains: search, mode: 'insensitive' } },
    ];
  }
  const employees = await prisma.employee.findMany({
    where,
    include: { branch: { select: { nameAr: true } } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ data: employees });
});

app.get('/api/employees/:id', authenticate, async (req, res) => {
  const employee = await prisma.employee.findUnique({
    where: { id: req.params.id },
    include: { branch: true, user: { select: { email: true } } },
  });
  if (!employee) return res.status(404).json({ error: 'غير موجود' });
  res.json(employee);
});

app.post('/api/employees', authenticate, async (req, res) => {
  try {
    const { employeeNumber, nameAr, phone, branchId, position, baseSalary, pin } = req.body;
    if (!employeeNumber || !nameAr || !branchId || !position) {
      return res.status(400).json({ error: 'البيانات ناقصة' });
    }

    // Create user first (with PIN)
    const pinHash = pin ? await bcrypt.hash(pin, 10) : null;
    const user = await prisma.user.create({
      data: {
        pin: pinHash,
        role: 'EMPLOYEE',
      },
    });

    const employee = await prisma.employee.create({
      data: {
        employeeNumber,
        nameAr,
        phone,
        branchId,
        position,
        baseSalary: baseSalary ? parseFloat(baseSalary) : 0,
        userId: user.id,
        status: 'PROBATION',
      },
      include: { branch: true },
    });
    res.status(201).json(employee);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/employees/:id', authenticate, async (req, res) => {
  try {
    const { pin, ...rest } = req.body;
    const employee = await prisma.employee.update({
      where: { id: req.params.id },
      data: rest,
      include: { branch: true, user: true },
    });

    // Update PIN if provided
    if (pin && employee.userId) {
      const pinHash = await bcrypt.hash(pin, 10);
      await prisma.user.update({ where: { id: employee.userId }, data: { pin: pinHash } });
    }
    res.json(employee);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════ ATTENDANCE ═══════════════════
app.post('/api/attendance/clock', authenticate, upload.single('photo'), async (req, res) => {
  try {
    const employeeId = req.user.employeeId;
    if (!employeeId) return res.status(403).json({ error: 'غير مصرح' });

    const { type, latitude, longitude } = req.body;
    if (!type || latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'البيانات ناقصة' });
    }

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { branch: true },
    });
    if (!employee) return res.status(404).json({ error: 'الموظف غير موجود' });

    // Check geofence
    const distance = distanceMeters(
      parseFloat(latitude), parseFloat(longitude),
      employee.branch.latitude, employee.branch.longitude
    );
    const isValid = distance <= employee.branch.geofenceRadius;

    // Upload photo
    let photoUrl = null;
    if (req.file) {
      photoUrl = await uploadPhoto(req.file.buffer, `attendance/${employeeId}/${Date.now()}.jpg`);
    }

    const attendance = await prisma.attendance.create({
      data: {
        employeeId,
        branchId: employee.branchId,
        type,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        photoUrl,
        isValid,
        notes: isValid ? null : `خارج النطاق بمسافة ${Math.round(distance)}م`,
      },
    });

    res.status(201).json({
      attendance,
      message: isValid ? 'تم تسجيل البصمة' : `خارج النطاق (${Math.round(distance)}م)`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/attendance/my', authenticate, async (req, res) => {
  const employeeId = req.user.employeeId;
  if (!employeeId) return res.status(403).json({ error: 'غير مصرح' });
  const logs = await prisma.attendance.findMany({
    where: { employeeId },
    orderBy: { timestamp: 'desc' },
    take: 100,
  });
  res.json({ data: logs });
});

app.get('/api/attendance/today', authenticate, async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const logs = await prisma.attendance.findMany({
    where: { timestamp: { gte: today } },
    include: {
      employee: { select: { nameAr: true, employeeNumber: true } },
      branch: { select: { nameAr: true } },
    },
    orderBy: { timestamp: 'desc' },
    take: 200,
  });
  res.json({ data: logs });
});

// ═══════════════════ REQUESTS ═══════════════════
app.post('/api/requests', authenticate, async (req, res) => {
  try {
    const employeeId = req.user.employeeId;
    if (!employeeId) return res.status(403).json({ error: 'غير مصرح' });
    const { type, reason, startDate, endDate, daysRequested } = req.body;
    const request = await prisma.request.create({
      data: {
        employeeId,
        type,
        reason,
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        daysRequested: daysRequested ? parseInt(daysRequested) : null,
      },
    });
    res.status(201).json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/requests/my', authenticate, async (req, res) => {
  const employeeId = req.user.employeeId;
  if (!employeeId) return res.status(403).json({ error: 'غير مصرح' });
  const requests = await prisma.request.findMany({
    where: { employeeId },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ data: requests });
});

app.get('/api/requests/pending', authenticate, async (req, res) => {
  const requests = await prisma.request.findMany({
    where: { status: 'PENDING' },
    include: {
      employee: { select: { nameAr: true, employeeNumber: true, branch: { select: { nameAr: true } } } },
    },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ data: requests });
});

app.post('/api/requests/:id/approve', authenticate, async (req, res) => {
  try {
    const request = await prisma.request.update({
      where: { id: req.params.id },
      data: { status: 'APPROVED' },
    });
    res.json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/requests/:id/reject', authenticate, async (req, res) => {
  try {
    const request = await prisma.request.update({
      where: { id: req.params.id },
      data: { status: 'REJECTED' },
    });
    res.json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════ DASHBOARD KPIs ═══════════════════
app.get('/api/dashboard/kpis', authenticate, async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [totalEmployees, totalBranches, todayAttendance, pendingRequests] = await Promise.all([
    prisma.employee.count({ where: { status: { in: ['ACTIVE', 'PROBATION'] } } }),
    prisma.branch.count({ where: { active: true } }),
    prisma.attendance.findMany({
      where: { timestamp: { gte: today }, type: 'CHECK_IN' },
      distinct: ['employeeId'],
      select: { employeeId: true, isValid: true },
    }),
    prisma.request.count({ where: { status: 'PENDING' } }),
  ]);

  const activeToday = todayAttendance.length;
  const validAttendance = todayAttendance.filter((a) => a.isValid).length;
  const attendanceRate = totalEmployees > 0 ? Math.round((activeToday / totalEmployees) * 100) : 0;

  res.json({
    totalEmployees,
    totalBranches,
    activeToday,
    validAttendance,
    absent: Math.max(0, totalEmployees - activeToday),
    attendanceRate,
    pendingRequests,
  });
});

// ═══════════════════ ERROR HANDLER ═══════════════════
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'خطأ داخلي' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'المسار غير موجود' });
});

// ═══════════════════ START ═══════════════════
app.listen(PORT, () => {
  console.log(`✅ أثر HR API running on port ${PORT}`);
});
