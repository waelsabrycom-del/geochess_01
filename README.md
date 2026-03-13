<<<<<<< HEAD
<<<<<<< HEAD
# نظام قاعدة البيانات - الشطرنج الجغرافي

## نظرة عامة
تم تطوير نظام إدارة قاعدة بيانات متكامل للعبة الشطرنج الجغرافي مع دعم التسجيل والدخول والمباريات.

## المتطلبات
- Node.js v14 أو أعلى
- npm أو yarn
- SQLite3 (يتم تثبيتها تلقائياً مع npm)

## البدء السريع

### 1. التثبيت
```bash
# تثبيت المكتبات المطلوبة
npm install
```

### 2. بدء الخادم
```bash
# تشغيل الخادم في وضع الإنتاج
npm start

# أو للتطوير مع إعادة تحميل تلقائي
npm run dev
```

الخادم سيعمل على: `http://localhost:3000`

## هيكلة المشروع الحالية

تم تنظيم المشروع لتقليل الزحام في الجذر مع الإبقاء على ملفات التشغيل الأساسية في مكانها:

```text
.
|- server.js
|- auth.js
|- database.js
|- package.json
|- index.html
|- [صفحات اللعبة الأساسية].html
|- docs/
|  |- chat/
|  |- reports/
|  |- general/
|  |- assets/screenshots/
|- scripts/
|  |- checks/
|  |- tools/
|- tests/
|- assets/
|  |- design-sources/
|  |- backups/
|- logs/
|- maps/
|- uploads/
```

ملاحظات سريعة:
- تم الإبقاء على ملفات التشغيل (`server.js`, `package.json`) في الجذر لتفادي كسر أوامر التشغيل.
- `docs/assets/screenshots` يحتوي صور التوثيق والواجهات.
- `assets/design-sources` يحتوي ملفات التصميم الأصلية (مثل `cdr`).

## هيكل قاعدة البيانات

### 1. جدول المستخدمين (users)
يحتفظ ببيانات كل مستخدم:
```sql
- id: معرف فريد
- username: اسم المستخدم
- email: البريد الإلكتروني
- password: كلمة المرور المشفرة
- avatar_url: رابط الصورة الشخصية
- level: مستوى اللاعب (1-60+)
- experience_points: نقاط الخبرة
- rank: الرتبة (مبتدئ، محترف، ماستر، إلخ)
- global_rank: الترتيب العالمي
- league: الدوري (برونزي، فضي، ذهبي، إلخ)
- wins: عدد الانتصارات
- losses: عدد الخسائر
- total_games: إجمالي المباريات
```

### 2. جدول المباريات (games)
معلومات كل مباراة:
```sql
- id: معرف المباراة
- game_name: اسم المباراة
- host_id: معرف المضيف
- opponent_id: معرف الخصم
- map_name: اسم الخريطة
- map_size: حجم الخريطة (صغير/وسط/كبير)
- status: حالة المباراة (waiting/ready/playing/finished)
- game_mode: نوع المباراة (pvp/ai/etc)
- winner_id: معرف الفائز
- created_at: وقت الإنشاء
- started_at: وقت البدء
- ended_at: وقت الانتهاء
```

### 3. جدول المشاركين (game_players)
لاعبو كل مباراة:
```sql
- id: معرف المشارك
- game_id: معرف المباراة
- user_id: معرف المستخدم
- player_side: جانب اللعبة (white/black)
- is_ready: هل اللاعب جاهز
- army_deployed: هل تم نشر الجيش
- joined_at: وقت الانضمام
```

### 4. جدول الخرائط (maps)
الخرائط المتاحة:
```sql
- id: معرف الخريطة
- name: اسم الخريطة
- description: الوصف
- width: العرض
- height: الارتفاع
- difficulty: المستوى (سهل/وسط/صعب)
- image_url: رابط الصورة
```

### 5. جداول إضافية
- **friends**: قائمة الأصدقاء
- **battle_history**: سجل المعارك
- **achievements**: الإنجازات
- **sessions**: جلسات المستخدمين

## API Endpoints

### المصادقة (Authentication)

#### تسجيل مستخدم جديد
```
POST /api/auth/register
Content-Type: application/json

{
  "username": "اسم المستخدم",
  "email": "email@example.com",
  "password": "password123",
  "confirmPassword": "password123"
}

Response:
{
  "success": true,
  "message": "تم التسجيل بنجاح",
  "token": "jwt_token_here",
  "user": {
    "id": 1,
    "username": "اسم المستخدم",
    "email": "email@example.com"
  }
}
```

#### تسجيل الدخول
```
POST /api/auth/login
Content-Type: application/json

{
  "email": "email@example.com",
  "password": "password123"
}

Response:
{
  "success": true,
  "message": "تم الدخول بنجاح",
  "token": "jwt_token_here",
  "user": {
    "id": 1,
    "username": "اسم المستخدم",
    "email": "email@example.com",
    "level": 55,
    "experience_points": 45200,
    "rank": "ماستر",
    "wins": 89,
    "losses": 53,
    "total_games": 142
  }
}
```

#### الحصول على بيانات الملف الشخصي
```
GET /api/auth/profile
Authorization: Bearer jwt_token_here

Response:
{
  "success": true,
  "user": {
    "id": 1,
    "username": "اسم المستخدم",
    "email": "email@example.com",
    "level": 55,
    "experience_points": 45200,
    "rank": "ماستر",
    "global_rank": 1240,
    "league": "الدوري الذهبي",
    "wins": 89,
    "losses": 53,
    "total_games": 142,
    "avatar_url": "url_here"
  }
}
```

#### تسجيل الخروج
```
POST /api/auth/logout
Authorization: Bearer jwt_token_here

Response:
{
  "success": true,
  "message": "تم الخروج بنجاح"
}
```

### المباريات (Games)

#### إنشاء مباراة جديدة
```
POST /api/games/create
Content-Type: application/json

{
  "host_id": 1,
  "game_name": "اسم المباراة",
  "map_name": "صحراء سيناء",
  "map_size": "medium"
}

Response:
{
  "success": true,
  "message": "تم إنشاء اللعبة بنجاح",
  "gameId": 1
}
```

#### الحصول على الألعاب المتاحة
```
GET /api/games/available

Response:
{
  "success": true,
  "games": [
    {
      "id": 1,
      "game_name": "معركة الحدود الشمالية",
      "host_name": "الجنرال خالد",
      "map_name": "الجبال الوعرة",
      "status": "waiting",
      "created_at": "2024-01-27T10:30:00Z"
    }
  ]
}
```

#### الانضمام إلى مباراة
```
POST /api/games/join
Content-Type: application/json

{
  "game_id": 1,
  "user_id": 2
}

Response:
{
  "success": true,
  "message": "تم الانضمام للعبة بنجاح"
}
```

## ملفات HTML الرئيسية

### 1. إنشاء حساب جديد.html
صفحة تسجيل المستخدمين الجدد
- طلب اسم المستخدم والبريد الإلكتروني وكلمة المرور
- التحقق من صحة البيانات
- إعادة توجيه للملف الشخصي بعد النجاح

### 2. تسجيل دخول.html (تم إنشاؤها)
صفحة دخول المستخدمين الموجودين
- طلب البريد الإلكتروني وكلمة المرور
- تذكر المستخدم اختياريًا
- خيار استرجاع كلمة المرور

### 3. ملف اللاعب الشخصي.html
الملف الشخصي للاعب
- عرض البيانات الشخصية والإحصائيات
- سجل المعارك السابقة
- قائمة الأصدقاء
- الغرف المتاحة للانضمام

## كيفية الاستخدام

### سير العمل العادي:

1. **التسجيل**
   - افتح صفحة `إنشاء حساب جديد.html`
   - أدخل البيانات المطلوبة
   - اضغط "إنشاء حساب"
   - سيتم التحويل تلقائياً للملف الشخصي

2. **الدخول اللاحق**
   - افتح صفحة `تسجيل دخول.html`
   - أدخل البريد الإلكتروني وكلمة المرور
   - اضغط "تسجيل الدخول"
   - سيتم التحويل للملف الشخصي

3. **الملف الشخصي**
   - عرض الإحصائيات والتصنيفات
   - إنشاء مباراة جديدة
   - الانضمام لمباريات أخرى
   - عرض سجل المعارك

## التخزين المحلي (LocalStorage)

يتم حفظ البيانات التالية محلياً:
```javascript
localStorage.setItem('authToken', token);        // التوكن
localStorage.setItem('userId', user.id);        // معرف المستخدم
localStorage.setItem('username', user.username);// اسم المستخدم
localStorage.setItem('userLevel', user.level);  // المستوى
localStorage.setItem('userRank', user.rank);    // الرتبة
```

## الأمان

- كلمات المرور مشفرة باستخدام bcryptjs
- التوثيق عبر JWT tokens
- التحقق من الصلاحيات على كل طلب
- حماية CORS مفعلة

## معالجة الأخطاء

جميع الـ API endpoints ترجع:
```json
{
  "success": false,
  "message": "وصف الخطأ"
}
```

## التطوير المستقبلي

- [ ] نظام الدردشة الفورية
- [ ] نظام الإشعارات
- [ ] حفظ تقدم المباريات
- [ ] نظام الإنجازات والشارات
- [ ] نظام الترتيبات العالمية
- [ ] تطبيق الهاتف المحمول
- [ ] نظام الرهانات والمكافآت

## حل المشاكل الشائعة

### الخادم لا يعمل
```bash
# تأكد من تثبيت المكتبات
npm install

# تأكد من الميناء 3000 غير مستخدم
lsof -i :3000
```

### خطأ في الاتصال بقاعدة البيانات
```bash
# حذف قاعدة البيانات وإعادة إنشاؤها
rm -rf database/chess_game.db
npm start
```

### خطأ في التوثيق
تأكد من:
- التوكن محفوظ في localStorage
- التوكن يتم إرساله بشكل صحيح: `Authorization: Bearer token`
- التوكن لم ينتهِ صلاحيته (7 أيام)

## المراجع

- Express.js: https://expressjs.com
- SQLite: https://www.sqlite.org
- JWT: https://jwt.io
- bcryptjs: https://github.com/dcodeIO/bcrypt.js

---

**آخر تحديث:** 27 يناير 2026
=======
# geochess_01
>>>>>>> e0cf40005837ebab2be181f06747006f095fead6
=======
# geochess_01
GeoChess project
>>>>>>> 5b0381630f080fbd058dbb5ad13fe6f92c7a1311
