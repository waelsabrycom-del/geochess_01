const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const authRoutes = require('./auth');
const tournamentsRoutes = require('./tournaments');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// === أمان: HTTP Security Headers ===
app.use(helmet({
    contentSecurityPolicy: false, // نعطله لأن المشروع يستخدم inline scripts
    crossOriginEmbedderPolicy: false
}));

// === CORS ===
app.use(cors({
    origin: true,
    credentials: true
}));

// === أمان: Rate Limiting ===
const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 دقيقة
    max: isProduction ? 200 : 1000, // حد الطلبات
    message: { success: false, message: 'طلبات كثيرة جداً، حاول لاحقاً' },
    standardHeaders: true,
    legacyHeaders: false
});

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 20 : 100, // حد أقل لنقاط المصادقة
    message: { success: false, message: 'محاولات دخول كثيرة، حاول بعد 15 دقيقة' },
    standardHeaders: true,
    legacyHeaders: false
});

app.use(generalLimiter);

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));  // دعم FormData من navigator.sendBeacon

// 📝 Logging middleware لكل الطلبات
app.use((req, res, next) => {
    console.log(`\n📨 ${req.method} ${req.url}`);
    if (req.headers.authorization) {
        console.log('   🔑 توجد Authorization header');
    }
    next();
});

app.use(express.static(__dirname));
// إتاحة الوصول إلى ملفات الصور المرفوعة
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// دالة التحقق من التوكن
if (isProduction && (!process.env.JWT_SECRET || process.env.JWT_SECRET.includes('change-in-production') || process.env.JWT_SECRET.includes('change-this'))) {
    console.error('\n❌ خطأ حرج: يجب تعيين JWT_SECRET بقيمة آمنة في بيئة الإنتاج!');
    console.error('   أضف JWT_SECRET قوي في ملف .env');
    process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-key-not-for-production';

function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'لا توجد صلاحية' });
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).json({ success: false, message: 'توكن غير صحيح' });
        }
        req.user = { id: decoded.id };
        next();
    });
}

// ✅ تخزين أوقات بدء التوزيع لكل لعبة مع زمن التوزيع
const gameDistributionStartTimes = new Map(); // {gameId: {startTime, totalSeconds}}

// ✅ تخزين معلومات أدوار القتال لكل لعبة
const gameBattleTurns = new Map(); // {gameId: {currentTurn, turnStartTime, turnTimeSeconds}}

// استخدام مسارات المصادقة مع حماية Rate Limiting
app.use('/api/auth', authLimiter, authRoutes);

// استخدام مسارات البطولات
app.use('/api/tournaments', tournamentsRoutes);

// API لإنشاء لعبة جديدة
app.post('/api/games/create', (req, res) => {
    const { host_id, game_name, map_name, map_size, game_settings, host_color, guest_color } = req.body;

    if (!host_id || !game_name || !map_name) {
        return res.status(400).json({ 
            success: false, 
            message: 'البيانات المطلوبة غير كاملة' 
        });
    }

    // 🔍 أولاً: حذف أي مباراة قديمة للمستخدم بنفس الاسم (تجنب الـ UNIQUE constraint)
    console.log(`🟡 محاولة إنشاء مباراة جديدة: "${game_name}" للمستخدم ${host_id}`);
    
    // حذف الدعوات أولاً (FOREIGN KEY reference)
    db.run(
        `DELETE FROM game_invites WHERE game_id IN (
            SELECT id FROM games WHERE host_id = ? AND game_name = ?
        )`,
        [host_id, game_name],
        (deleteInvitesErr) => {
            if (deleteInvitesErr) {
                console.error('❌ خطأ حذف دعوات المباراة القديمة:', deleteInvitesErr.message);
                // نكمل حتى لو فشل (قد لا توجد دعوات)
            }

            // ثم حذف لاعبي المباراة
            db.run(
                `DELETE FROM game_players WHERE game_id IN (
                    SELECT id FROM games WHERE host_id = ? AND game_name = ?
                )`,
                [host_id, game_name],
                (deletePlayersErr) => {
                    if (deletePlayersErr) {
                        console.error('❌ خطأ حذف لاعبي المباراة القديمة:', deletePlayersErr.message);
                        // نكمل حتى لو فشل (قد لا توجد لاعبين)
                    }

                    // ثم حذف المباراة القديمة
                    db.run(
                        `DELETE FROM games WHERE host_id = ? AND game_name = ?`,
                        [host_id, game_name],
                        (deleteGameErr) => {
                            if (deleteGameErr) {
                                console.error('❌ خطأ حذف المباراة القديمة:', deleteGameErr.message);
                                return res.status(500).json({
                                    success: false,
                                    message: 'خطأ في حذف المباراة القديمة'
                                });
                            }

                            if (deleteGameErr === undefined || deleteGameErr === null) {
                                console.log('✅ تم حذف المباراة القديمة (إن وجدت)');
                            }

                            // 🟢 الآن إنشاء مباراة جديدة
                            db.run(
                                `INSERT INTO games (host_id, game_name, map_name, map_size, game_settings, host_color, guest_color, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'waiting')`,
                                [host_id, game_name, map_name, map_size || 'medium', game_settings ? JSON.stringify(game_settings) : null, host_color || 'white', guest_color || 'black'],
                                function(err) {
                                    if (err) {
                                        console.error('❌ خطأ إنشاء المباراة:', err.message);
                                        return res.status(500).json({
                                            success: false,
                                            message: 'خطأ في إنشاء اللعبة: ' + err.message
                                        });
                                    }

                                    const gameId = this.lastID;
                                    console.log(`🟢 تم إنشاء مباراة جديدة برقم: ${gameId}`);

                                    // إضافة المضيف كلاعب
                                    db.run(
                                        `INSERT INTO game_players (game_id, user_id, player_side) VALUES (?, ?, 'white')`,
                                        [gameId, host_id],
                                        (err) => {
                                            if (err) {
                                                console.error('❌ خطأ إضافة المضيف:', err.message);
                                                return res.status(500).json({
                                                    success: false,
                                                    message: 'خطأ في إضافة المضيف'
                                                });
                                            }

                                            console.log(`✅ تم إضافة المضيف (${host_id}) للمباراة (${gameId})`);
                                            res.status(201).json({
                                                success: true,
                                                message: 'تم إنشاء اللعبة بنجاح',
                                                gameId: gameId
                                            });
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        }
    );
});

// API للحصول على قائمة الألعاب المتاحة
app.get('/api/games/available', (req, res) => {
    db.all(
        `SELECT g.*, u.username as host_name, u.avatar_url 
         FROM games g 
         JOIN users u ON g.host_id = u.id 
         WHERE g.status IN ('waiting', 'ready')
         ORDER BY g.created_at DESC`,
        (err, games) => {
            if (err) {
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في جلب الألعاب' 
                });
            }

            res.json({
                success: true,
                games: games || []
            });
        }
    );
});

// API للانضمام إلى لعبة
app.post('/api/games/join', (req, res) => {
    const { game_id, user_id } = req.body;

    console.log(`\n👤 الضيف ينضم: user_id=${user_id}, game_id=${game_id}`);

    if (!game_id || !user_id) {
        return res.status(400).json({ 
            success: false, 
            message: 'معرف اللعبة والمستخدم مطلوب' 
        });
    }

    // التحقق من حالة اللعبة
    db.get(
        `SELECT * FROM games WHERE id = ?`,
        [game_id],
        (err, game) => {
            if (err || !game) {
                return res.status(404).json({ 
                    success: false, 
                    message: 'اللعبة غير موجودة' 
                });
            }

            if (game.status !== 'waiting') {
                return res.status(400).json({ 
                    success: false, 
                    message: 'اللعبة لم تعد متاحة' 
                });
            }

            // إضافة اللاعب
            db.run(
                `INSERT INTO game_players (game_id, user_id, player_side) VALUES (?, ?, 'black')`,
                [game_id, user_id],
                (err) => {
                    if (err) {
                        return res.status(500).json({ 
                            success: false, 
                            message: 'خطأ في الانضمام للعبة' 
                        });
                    }

                    // تحديث حالة اللعبة
                    db.run(
                        `UPDATE games SET opponent_id = ?, status = 'ready' WHERE id = ?`,
                        [user_id, game_id],
                        (err) => {
                            if (err) {
                                return res.status(500).json({ 
                                    success: false, 
                                    message: 'خطأ في تحديث اللعبة' 
                                });
                            }

                            console.log(`✅ تم تحديث opponent_id = ${user_id} للعبة ${game_id}`);
                            res.json({
                                success: true,
                                message: 'تم الانضمام للعبة بنجاح'
                            });
                        }
                    );
                }
            );
        }
    );
});

// API لحذف مباراة
// حذف مباراة معينة
app.delete('/api/games/:gameId', (req, res) => {
    const gameId = req.params.gameId;
    
    console.log(`\n🗑️  تم استقبال طلب حذف للعبة ID: ${gameId}`);

    if (!gameId) {
        console.log('❌ معرف اللعبة غير موجود');
        return res.status(400).json({ 
            success: false, 
            message: 'معرف اللعبة مطلوب' 
        });
    }

    // يجب حذف البيانات المرتبطة بالترتيب الصحيح لتجنب FOREIGN KEY constraint
    // الترتيب الصحيح: الجداول التي بدون ON DELETE CASCADE أولاً
    
    // 1. حذف الرسائل في شات البطولة
    db.run(
        `DELETE FROM tournament_chat_messages WHERE game_id = ?`,
        [gameId],
        (err) => {
            if (err) console.log('ℹ️  لا توجد رسائل شات للحذف');

            // 2. حذف الدعوات
            db.run(
                `DELETE FROM game_invites WHERE game_id = ?`,
                [gameId],
                (err) => {
                    if (err) console.log('ℹ️  لا توجد دعوات للحذف');

                    // 3. حذف سجل المعارك
                    db.run(
                        `DELETE FROM battle_history WHERE game_id = ?`,
                        [gameId],
                        (err) => {
                            if (err) console.log('ℹ️  لا يوجد سجل معارك للحذف');

                            // 4. حذف لاعبي المباراة
                            db.run(
                                `DELETE FROM game_players WHERE game_id = ?`,
                                [gameId],
                                (err) => {
                                    if (err) console.log('ℹ️  لا يوجد لاعبون مسجلون');

                                    // 5. حذف القطع (بـ ON DELETE CASCADE)
                                    db.run(
                                        `DELETE FROM game_pieces WHERE game_id = ?`,
                                        [gameId],
                                        (err) => {
                                            if (err) console.log('ℹ️  لا توجد قطع للحذف');

                                            // 6. حذف إحصائيات اللاعبين (بـ ON DELETE CASCADE)
                                            db.run(
                                                `DELETE FROM player_statistics WHERE game_id = ?`,
                                                [gameId],
                                                (err) => {
                                                    if (err) console.log('ℹ️  لا توجد إحصائيات للحذف');

                                                    // 7. أخيراً، حذف المباراة نفسها
                                                    db.run(
                                                        `DELETE FROM games WHERE id = ?`,
                                                        [gameId],
                                                        function(err) {
                                                            if (err) {
                                                                console.error('❌ خطأ في حذف المباراة:', err);
                                                                return res.status(500).json({ 
                                                                    success: false, 
                                                                    message: 'خطأ في حذف المباراة: ' + err.message
                                                                });
                                                            }
                                                            
                                                            console.log(`✓ تم حذف جميع بيانات المباراة ID: ${gameId}`);
                                                            
                                                            res.json({ 
                                                                success: true, 
                                                                message: 'تم حذف المباراة بنجاح' 
                                                            });
                                                        }
                                                    );
                                                }
                                            );
                                        }
                                    );
                                }
                            );
                        }
                    );
                }
            );
        }
    );
});

app.delete('/api/games/delete/:gameId', (req, res) => {
    const gameId = req.params.gameId;

    if (!gameId) {
        return res.status(400).json({ 
            success: false, 
            message: 'معرف اللعبة مطلوب' 
        });
    }

    // حذف لاعبي المباراة أولاً (FOREIGN KEY)
    db.run(
        `DELETE FROM game_players WHERE game_id = ?`,
        [gameId],
        (err) => {
            if (err) {
                console.error('خطأ في حذف لاعبي اللعبة:', err);
            }

            // ثم حذف المباراة
            db.run(
                `DELETE FROM games WHERE id = ?`,
                [gameId],
                function(err) {
                    if (err) {
                        return res.status(500).json({ 
                            success: false, 
                            message: 'خطأ في حذف اللعبة' 
                        });
                    }

                    console.log(`✅ تم حذف اللعبة: ${gameId}`);
                    res.json({
                        success: true,
                        message: 'تم حذف اللعبة بنجاح'
                    });
                }
            );
        }
    );
});

// API لطرد الضيف وإجباره على العودة إلى الملف الشخصي - يجب أن يكون قبل /api/games/:gameId
app.post('/api/games/:gameId/kick-guest', (req, res) => {
    const gameId = req.params.gameId;

    if (!gameId) {
        return res.status(400).json({ 
            success: false, 
            message: 'معرف اللعبة مطلوب' 
        });
    }

    // تحديث حالة اللعبة: وضع guest_kicked = 1 وحذف opponent_id
    // بحيث تصبح المباراة متاحة مرة أخرى
    db.run(
        `UPDATE games SET guest_kicked = 1, opponent_id = NULL, status = 'waiting' WHERE id = ?`,
        [gameId],
        function(err) {
            if (err) {
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في تحديث حالة اللعبة' 
                });
            }

            res.json({
                success: true,
                message: 'تم طرد الضيف بنجاح'
            });
        }
    );
});

// API عندما يخرج الضيف من الغرفة بنفسه
app.post('/api/games/:gameId/guest-left', (req, res) => {
    const gameId = req.params.gameId;

    if (!gameId) {
        return res.status(400).json({ 
            success: false, 
            message: 'معرف اللعبة مطلوب' 
        });
    }

    console.log(`🚪 الضيف غادر اللعبة ID: ${gameId}`);

    // تحديث حالة اللعبة: حذف opponent_id وإرجاع الحالة إلى waiting
    db.run(
        `UPDATE games SET opponent_id = NULL, status = 'waiting', guest_kicked = 0 WHERE id = ?`,
        [gameId],
        function(err) {
            if (err) {
                console.error('❌ خطأ تحديث حالة اللعبة:', err.message);
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في تحديث حالة اللعبة' 
                });
            }

            console.log(`✅ تم تحديث اللعبة ID: ${gameId} - تم حذف الضيف`);
            res.json({
                success: true,
                message: 'تم تحديث حالة اللعبة بنجاح'
            });
        }
    );
});

// API لرفض دعوة اللعبة (الضيف يرفض الانضمام)
app.post('/api/games/:gameId/reject-opponent', (req, res) => {
    const gameId = req.params.gameId;

    if (!gameId) {
        return res.status(400).json({ 
            success: false, 
            message: 'معرف اللعبة مطلوب' 
        });
    }

    console.log(`👋 رفض دعوة اللعبة ID: ${gameId}`);

    // تحديث حالة اللعبة: حذف opponent_id بدون تغيير الحالة (تبقى waiting)
    db.run(
        `UPDATE games SET opponent_id = NULL WHERE id = ?`,
        [gameId],
        function(err) {
            if (err) {
                console.error('❌ خطأ في رفض الدعوة:', err.message);
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في رفض الدعوة' 
                });
            }

            console.log(`✅ تم رفض دعوة اللعبة ID: ${gameId}`);
            res.json({
                success: true,
                message: 'تم رفض الدعوة بنجاح'
            });
        }
    );
});

// API لبدء اللعبة
app.post('/api/games/:gameId/start', (req, res) => {
    const gameId = req.params.gameId;

    if (!gameId) {
        return res.status(400).json({ 
            success: false, 
            message: 'معرف اللعبة مطلوب' 
        });
    }

    console.log(`\n🎮 بدء المعركة: gameId=${gameId}`);

    // تحديث حالة اللعبة إلى 'started'
    db.run(
        `UPDATE games SET status = 'started' WHERE id = ?`,
        [gameId],
        function(err) {
            if (err) {
                console.error(`❌ خطأ في تحديث حالة اللعبة: ${err.message}`);
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في تحديث حالة اللعبة' 
                });
            }

            console.log(`✅ تم تحديث status إلى 'started' للعبة ${gameId}`);
            res.json({
                success: true,
                message: 'تم بدء اللعبة بنجاح'
            });
        }
    );
});

// API لتحديث host_id في مباراة البطولة (عند دخول المضيف الفعلي)
app.post('/api/games/:gameId/update-host', (req, res) => {
    const gameId = req.params.gameId;
    const { host_id } = req.body;

    if (!gameId || !host_id) {
        return res.status(400).json({ 
            success: false, 
            message: 'معرف اللعبة ومعرف المضيف مطلوبان' 
        });
    }

    console.log(`\n👑 تحديث المضيف: gameId=${gameId}, host_id=${host_id}`);

    // تحديث host_id
    db.run(
        `UPDATE games SET host_id = ? WHERE id = ?`,
        [host_id, gameId],
        function(err) {
            if (err) {
                console.error(`❌ خطأ في تحديث المضيف: ${err.message}`);
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في تحديث المضيف' 
                });
            }

            console.log(`✅ تم تحديث host_id=${host_id} للعبة ${gameId}`);
            res.json({
                success: true,
                message: 'تم تحديث المضيف بنجاح'
            });
        }
    );
});

// API للحصول على بيانات مباراة محددة
app.get('/api/games/:gameId', (req, res) => {
    const gameId = req.params.gameId;
    db.get(
        `SELECT * FROM games WHERE id = ?`,
        [gameId],
        (err, game) => {
            if (err || !game) {
                return res.status(404).json({ 
                    success: false, 
                    message: 'المباراة غير موجودة' 
                });
            }
            console.log(`📋 جلب بيانات اللعبة ${gameId}:`, {
                host_id: game.host_id,
                opponent_id: game.opponent_id,
                status: game.status,
                guest_kicked: game.guest_kicked
            });
            res.json({
                success: true,
                game: game
            });
        }
    );
});

// API للتحقق من وجود مباراة مفتوحة للمستخدم الحالي
app.get('/api/games/user-active/:userId', (req, res) => {
    const userId = req.params.userId;
    
    db.get(
        `SELECT * FROM games WHERE host_id = ? AND status = 'waiting'`,
        [userId],
        (err, game) => {
            if (err) {
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في البحث عن المباريات' 
                });
            }
            
            if (game) {
                // هناك مباراة مفتوحة
                res.json({
                    success: true,
                    game: game
                });
            } else {
                // لا توجد مباراة مفتوحة
                res.json({
                    success: true,
                    game: null
                });
            }
        }
    );
});

// API لحذف جميع المباريات المفتوحة
app.delete('/api/games/delete-all', (req, res) => {
    // حذف جميع المباريات ذات الحالة 'waiting'
    db.run(
        `DELETE FROM games WHERE status = 'waiting'`,
        function(err) {
            if (err) {
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في حذف المباريات' 
                });
            }

            // حذف لاعبي المباريات المحذوفة
            db.run(
                `DELETE FROM game_players WHERE game_id NOT IN (SELECT id FROM games)`,
                (err) => {
                    if (err) {
                        console.error('خطأ في حذف لاعبي المباريات:', err);
                    }
                    
                    res.json({
                        success: true,
                        message: 'تم حذف جميع المباريات المفتوحة بنجاح'
                    });
                }
            );
        }
    );
});

// API للحصول على بيانات مستخدم محددة
// API لجلب جميع المستخدمين
app.get('/api/users', (req, res) => {
    db.all(
        `SELECT id, username, avatar_url, level FROM users LIMIT 100`,
        (err, users) => {
            if (err) {
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في جلب المستخدمين' 
                });
            }
            res.json({
                success: true,
                users: users || []
            });
        }
    );
});

app.get('/api/users/:userId', (req, res) => {
    const userId = req.params.userId;
    db.get(
        `SELECT id, username, avatar_url, level FROM users WHERE id = ?`,
        [userId],
        (err, user) => {
            if (err || !user) {
                return res.status(404).json({ 
                    success: false, 
                    message: 'المستخدم غير موجود' 
                });
            }
            res.json({
                success: true,
                user: user
            });
        }
    );
});

// API لجلب سجل المعارك
app.get('/api/battles/history/:userId', (req, res) => {
    const userId = req.params.userId;

    db.all(
        `SELECT bh.*, u.username as opponent_name, u.avatar_url 
         FROM battle_history bh 
         JOIN users u ON bh.opponent_id = u.id 
         WHERE bh.user_id = ? 
         ORDER BY bh.date DESC`,
        [userId],
        (err, battles) => {
            if (err) {
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في جلب السجل' 
                });
            }

            res.json({
                success: true,
                battles: battles || []
            });
        }
    );
});

// ⚠️ الـ routes المحددة يجب أن تأتي قبل الـ route الديناميكي (:userId)

// الحصول على الدعوات المعلقة
app.get('/api/friends/pending', (req, res, next) => {
    console.log('\n🔔 تم استقبال طلب GET إلى /api/friends/pending');
    console.log('Headers:', req.headers.authorization);
    next();
}, authenticateToken, (req, res) => {
    const userId = req.user.id;
    console.log(`\n=== البحث عن طلبات الصداقة ===`);
    console.log(`المستخدم الحالي: ${userId} (نوع: ${typeof userId})`);
    
    // اعرض جميع البيانات أولاً
    db.all('SELECT * FROM friends', (err, allFriends) => {
        console.log('جميع بيانات جدول friends:');
        if (allFriends && allFriends.length > 0) {
            allFriends.forEach(f => {
                console.log(`  user_id=${f.user_id}, friend_id=${f.friend_id}, status=${f.status}`);
            });
        } else {
            console.log('  الجدول فارغ!');
        }
    });
    
    const query = `SELECT u.id, u.username, u.avatar_url, u.email 
         FROM friends f 
         JOIN users u ON f.user_id = u.id 
         WHERE f.friend_id = ? AND f.status = 'pending'`;
    
    console.log(`استعلام SQL: ${query}`);
    console.log(`القيمة المُمررة: friend_id = ${userId}`);
    
    db.all(query, [userId], (err, requests) => {
        if (err) {
            console.error('خطأ في قاعدة البيانات:', err);
            return res.status(500).json({
                success: false,
                message: 'خطأ في جلب الدعوات'
            });
        }
        
        console.log(`النتائج: ${requests ? requests.length : 0} طلب صداقة`);
        if (requests && requests.length > 0) {
            console.log('الطلبات:', JSON.stringify(requests, null, 2));
        }
        console.log(`=== انتهى البحث ===\n`);
        
        res.json({
            success: true,
            requests: requests || []
        });
    });
});

// الحصول على الأصدقاء المقبولين
app.get('/api/friends/accepted', authenticateToken, (req, res) => {
    const userId = req.user.id;
    
    db.all(
        `SELECT u.id, u.username, u.avatar_url, u.email 
         FROM friends f 
         JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id) 
         WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted' AND u.id != ?`,
        [userId, userId, userId],
        (err, friends) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في جلب الأصدقاء'
                });
            }
            
            res.json({
                success: true,
                friends: friends || []
            });
        }
    );
});

// قبول دعوة صداقة
app.post('/api/friends/accept', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const { friendId } = req.body;
    
    if (!friendId) {
        return res.status(400).json({
            success: false,
            message: 'معرف الصديق مطلوب'
        });
    }
    
    // تحديث حالة الدعوة من pending إلى accepted
    db.run(
        'UPDATE friends SET status = ? WHERE user_id = ? AND friend_id = ?',
        ['accepted', friendId, userId],
        function(err) {
            if (err) {
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في قبول الدعوة'
                });
            }
            
            res.json({
                success: true,
                message: 'تم قبول طلب الصداقة'
            });
        }
    );
});

// رفض دعوة صداقة
app.post('/api/friends/reject', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const { friendId } = req.body;
    
    if (!friendId) {
        return res.status(400).json({
            success: false,
            message: 'معرف الصديق مطلوب'
        });
    }
    
    // حذف الدعوة
    db.run(
        'DELETE FROM friends WHERE user_id = ? AND friend_id = ? AND status = ?',
        [friendId, userId, 'pending'],
        function(err) {
            if (err) {
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في رفض الدعوة'
                });
            }
            
            res.json({
                success: true,
                message: 'تم رفض طلب الصداقة'
            });
        }
    );
});

// إلغاء الصداقة
app.post('/api/friends/remove', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const { friendId } = req.body;

    console.log(`\n🗑️  طلب إزالة صداقة: المستخدم ${userId} يحذف الصديق ${friendId}`);

    if (!friendId) {
        console.error('❌ معرف الصديق مفقود');
        return res.status(400).json({
            success: false,
            message: 'معرف الصديق مطلوب'
        });
    }

    db.run(
        `DELETE FROM friends
         WHERE status = 'accepted'
           AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))`,
        [userId, friendId, friendId, userId],
        function(err) {
            if (err) {
                console.error('❌ خطأ في حذف الصديق:', err);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في إزالة الصديق'
                });
            }

            console.log(`✅ عدد الصفوف المحذوفة: ${this.changes}`);

            if (this.changes === 0) {
                console.warn('⚠️ لم يتم العثور على صداقة للحذف');
                return res.status(404).json({
                    success: false,
                    message: 'لا يوجد صديق بهذه البيانات'
                });
            }

            console.log(`✅ تم حذف الصداقة بنجاح`);
            res.json({
                success: true,
                message: 'تم إزالة الصديق بنجاح'
            });
        }
    );
});

// API لجلب قائمة الأصدقاء (الـ route الديناميكي يأتي أخيراً)
app.get('/api/friends/:userId', (req, res) => {
    const userId = req.params.userId;

    db.all(
        `SELECT u.*, f.status 
         FROM friends f 
         JOIN users u ON f.friend_id = u.id 
         WHERE f.user_id = ? AND f.status = 'accepted'`,
        [userId],
        (err, friends) => {
            if (err) {
                return res.status(500).json({ 
                    success: false, 
                    message: 'خطأ في جلب الأصدقاء' 
                });
            }

            res.json({
                success: true,
                friends: friends || []
            });
        }
    );
});

// API لإضافة صديق
app.post('/api/friends/add', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const { friendEmail } = req.body;

    if (!friendEmail) {
        return res.status(400).json({
            success: false,
            message: 'البريد الإلكتروني مطلوب'
        });
    }

    // ابحث عن المستخدم برقم البريد الإلكتروني
    db.get('SELECT id FROM users WHERE email = ?', [friendEmail], (err, friend) => {
        if (err) {
            return res.status(500).json({
                success: false,
                message: 'خطأ في البحث عن المستخدم'
            });
        }

        if (!friend) {
            return res.status(404).json({
                success: false,
                message: 'المستخدم غير موجود'
            });
        }

        if (friend.id === userId) {
            return res.status(400).json({
                success: false,
                message: 'لا يمكن إضافة نفسك كصديق'
            });
        }

        // تحقق من وجود علاقة صداقة مسبقة
        db.get(
            'SELECT status FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
            [userId, friend.id, friend.id, userId],
            (err, existingFriend) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        message: 'خطأ في التحقق'
                    });
                }

                if (existingFriend) {
                    if (existingFriend.status === 'accepted') {
                        return res.status(400).json({
                            success: false,
                            message: 'هذا الشخص موجود بالفعل في قائمة أصدقائك'
                        });
                    } else if (existingFriend.status === 'pending') {
                        return res.status(400).json({
                            success: false,
                            message: 'طلب صداقة معلق بالفعل'
                        });
                    }
                }

                // أضف طلب الصداقة
                db.run(
                    'INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)',
                    [userId, friend.id, 'pending'],
                    function(err) {
                        if (err) {
                            return res.status(500).json({
                                success: false,
                                message: 'خطأ في إضافة الصديق'
                            });
                        }

                        res.json({
                            success: true,
                            message: 'تم إرسال طلب الصداقة بنجاح'
                        });
                    }
                );
            }
        );
    });
});

// API لإرسال طلب صداقة لمستخدم معين بواسطة ID
app.post('/api/friends/request', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const { friendId } = req.body;

    console.log(`\n=== طلب صداقة جديد ===`);
    console.log(`المرسل: ${userId}`);
    console.log(`المستقبل: ${friendId}`);

    if (!friendId) {
        return res.status(400).json({
            success: false,
            message: 'معرف الصديق مطلوب'
        });
    }

    if (userId === friendId) {
        return res.status(400).json({
            success: false,
            message: 'لا يمكن إضافة نفسك كصديق'
        });
    }

    // تحقق من وجود المستخدم
    db.get('SELECT id FROM users WHERE id = ?', [friendId], (err, friend) => {
        if (err || !friend) {
            console.log(`المستخدم ${friendId} غير موجود`);
            return res.status(404).json({
                success: false,
                message: 'المستخدم غير موجود'
            });
        }

        // تحقق من وجود علاقة صداقة مسبقة
        db.get(
            'SELECT status FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
            [userId, friendId, friendId, userId],
            (err, existingFriend) => {
                if (err) {
                    return res.status(500).json({
                        success: false,
                        message: 'خطأ في التحقق'
                    });
                }

                if (existingFriend) {
                    if (existingFriend.status === 'accepted') {
                        return res.status(400).json({
                            success: false,
                            message: 'هذا الشخص موجود بالفعل في قائمة أصدقائك'
                        });
                    } else if (existingFriend.status === 'pending') {
                        return res.status(400).json({
                            success: false,
                            message: 'طلب صداقة معلق بالفعل'
                        });
                    }
                }

                // أضف طلب الصداقة
                db.run(
                    'INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)',
                    [userId, friendId, 'pending'],
                    function(err) {
                        if (err) {
                            console.error('خطأ في إدراج الصداقة:', err);
                            return res.status(500).json({
                                success: false,
                                message: 'خطأ في إضافة الصديق'
                            });
                        }

                        console.log(`✓ تم حفظ الطلب: user_id=${userId}, friend_id=${friendId}`);
                        console.log(`=== انتهى الطلب ===\n`);
                        
                        res.json({
                            success: true,
                            message: 'تم إرسال طلب الصداقة بنجاح'
                        });
                    }
                );
            }
        );
    });
});

// Endpoint للتحقق من جميع البيانات (للتصحيح فقط)
app.get('/api/debug/friends-all', authenticateToken, (req, res) => {
    db.all('SELECT * FROM friends', (err, friends) => {
        if (err) {
            return res.status(500).json({ error: err });
        }
        res.json(friends);
    });
});

// Endpoint لمسح جميع الطلبات المعلقة (للتصحيح فقط)
app.delete('/api/debug/clear-pending', authenticateToken, (req, res) => {
    db.run('DELETE FROM friends WHERE status = ?', ['pending'], function(err) {
        if (err) {
            return res.status(500).json({ 
                success: false, 
                error: err 
            });
        }
        res.json({ 
            success: true, 
            message: `تم حذف ${this.changes} طلب معلق`,
            deleted: this.changes
        });
    });
});

// Endpoint لمسح جميع البيانات من جدول friends (للتصحيح فقط)
app.delete('/api/debug/clear-all-friends', authenticateToken, (req, res) => {
    db.run('DELETE FROM friends', function(err) {
        if (err) {
            return res.status(500).json({ 
                success: false, 
                error: err 
            });
        }
        res.json({ 
            success: true, 
            message: `تم حذف ${this.changes} سجل من جدول الأصدقاء`,
            deleted: this.changes
        });
    });
});

// تقديم الملفات الثابتة
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/home', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// التعامل مع الأخطاء
// API لحفظ الخريطة
app.post('/api/maps/save', (req, res) => {
    const { name, width, height, data, isLocked, isDraft, locations, totalLocations, overwrite } = req.body;

    console.log('محاولة حفظ الخريطة:', { name, width, height, dataLength: data ? data.length : 0, isLocked, totalLocations });

    if (!name || !width || !height || !data) {
        console.error('بيانات ناقصة:', { name: !!name, width: !!width, height: !!height, data: !!data });
        return res.status(400).json({ 
            success: false, 
            message: 'البيانات المطلوبة غير كاملة' 
        });
    }

    // التأكد من وجود مجلد maps
    const mapsDir = path.join(__dirname, 'maps');
    if (!fs.existsSync(mapsDir)) {
        fs.mkdirSync(mapsDir, { recursive: true });
    }

    let filename = null;

    if (overwrite) {
        const normalizedName = String(name).trim();
        const candidateFiles = fs.readdirSync(mapsDir).filter(file => file.endsWith('.json'));
        const matched = candidateFiles
            .map(file => {
                const filepath = path.join(mapsDir, file);
                try {
                    const raw = fs.readFileSync(filepath, 'utf8');
                    const mapData = JSON.parse(raw);
                    if (String(mapData.name || '').trim() === normalizedName) {
                        const stat = fs.statSync(filepath);
                        return { file, mtime: stat.mtimeMs, isLocked: !!mapData.isLocked };
                    }
                } catch (e) {
                    return null;
                }
                return null;
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime);

        if (matched.length > 0) {
            if (matched[0].isLocked) {
                return res.status(403).json({
                    success: false,
                    message: 'الخريطة مقفلة ولا يمكن استبدالها'
                });
            }
            filename = matched[0].file;
        }
    }

    if (!filename) {
        // إنشاء اسم الملف بناءً على الوقت الحالي
        const timestamp = new Date().getTime();
        filename = `${name.replace(/\s+/g, '_')}_${timestamp}.json`;
    }

    const filepath = path.join(mapsDir, filename);

    // بيانات الخريطة
    const mapData = {
        name,
        width,
        height,
        data,
        isLocked: isLocked || false,
        isDraft: isDraft || false,
        locations: locations || {},
        totalLocations: totalLocations || 1,
        createdAt: new Date().toISOString(),
        version: '1.0'
    };

    // حفظ الملف
    fs.writeFile(filepath, JSON.stringify(mapData, null, 2), 'utf8', (err) => {
        if (err) {
            console.error('خطأ في حفظ الخريطة:', err);
            return res.status(500).json({ 
                success: false, 
                message: 'خطأ في حفظ الخريطة: ' + err.message 
            });
        }

        console.log('تم حفظ الخريطة بنجاح:', filename);
        res.json({ 
            success: true, 
            message: 'تم حفظ الخريطة بنجاح',
            filename: filename,
            path: `/maps/${filename}`
        });
    });
});

// API لتحميل قائمة الخرائط المحفوظة
app.get('/api/maps/list', (req, res) => {
    const mapsDir = path.join(__dirname, 'maps');
    
    if (!fs.existsSync(mapsDir)) {
        return res.json({ success: true, maps: [] });
    }

    fs.readdir(mapsDir, (err, files) => {
        if (err) {
            console.error('خطأ في قراءة الخرائط:', err);
            return res.status(500).json({ 
                success: false, 
                message: 'خطأ في قراءة الخرائط' 
            });
        }

        const maps = files
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const filepath = path.join(mapsDir, file);
                try {
                    const data = fs.readFileSync(filepath, 'utf8');
                    const mapData = JSON.parse(data);
                    
                    // التحقق من وجود حقل locations (يعني تم استخدام أداة الموقع)
                    // يجب أن يكون locations كائناً غير فارغ
                    let hasLocations = false;
                    if (mapData.locations && typeof mapData.locations === 'object') {
                        const locKeys = Object.keys(mapData.locations);
                        hasLocations = locKeys.length > 0;
                    }
                    
                    return {
                        filename: file,
                        path: `/maps/${file}`,
                        name: mapData.name || file.replace('.json', ''),
                        isLocked: mapData.isLocked || false,
                        isDraft: mapData.isDraft || false,
                        hasLocations: hasLocations
                    };
                } catch (e) {
                    console.error(`خطأ في قراءة الخريطة ${file}:`, e);
                    return {
                        filename: file,
                        path: `/maps/${file}`,
                        name: file.replace('.json', ''),
                        isLocked: false,
                        isDraft: false,
                        hasLocations: false
                    };
                }
            });

        res.json({ success: true, maps });
    });
});

// API لتحميل خريطة محفوظة
app.get('/api/maps/load/:filename', (req, res) => {
    const { filename } = req.params;
    const filepath = path.join(__dirname, 'maps', filename);

    // التحقق من أن الملف في مجلد maps فقط
    if (!filepath.startsWith(path.join(__dirname, 'maps'))) {
        return res.status(403).json({ 
            success: false, 
            message: 'لا يمكن تحميل هذا الملف' 
        });
    }

    // التحقق من أن امتداد الملف .json
    if (!filename.endsWith('.json')) {
        return res.status(400).json({ 
            success: false, 
            message: 'صيغة الملف غير صحيحة' 
        });
    }

    fs.readFile(filepath, 'utf8', (err, data) => {
        if (err) {
            console.error('خطأ في قراءة الخريطة:', err);
            return res.status(404).json({ 
                success: false, 
                message: 'الخريطة غير موجودة' 
            });
        }

        try {
            const mapData = JSON.parse(data);
            res.json(mapData);
        } catch (parseErr) {
            console.error('خطأ في معالجة ملف الخريطة:', parseErr);
            res.status(500).json({ 
                success: false, 
                message: 'خطأ في معالجة الخريطة' 
            });
        }
    });
});

// API لحذف خريطة محفوظة
app.delete('/api/maps/delete/:filename', (req, res) => {
    const { filename } = req.params;
    const filepath = path.join(__dirname, 'maps', filename);

    // التحقق من أن الملف في مجلد maps فقط
    if (!filepath.startsWith(path.join(__dirname, 'maps'))) {
        return res.status(403).json({ 
            success: false, 
            message: 'لا يمكن حذف هذا الملف' 
        });
    }

    fs.unlink(filepath, (err) => {
        if (err) {
            console.error('خطأ في حذف الخريطة:', err);
            return res.status(500).json({ 
                success: false, 
                message: 'خطأ في حذف الخريطة' 
            });
        }

        res.json({ 
            success: true, 
            message: 'تم حذف الخريطة بنجاح' 
        });
    });
});

// ========== API لنظام الدعوات ==========

// API لإرسال دعوة لاعب للانضمام
app.post('/api/games/:gameId/invite-player', (req, res) => {
    const gameId = req.params.gameId;
    const { from_user_id, to_user_id } = req.body;

    if (!gameId || !from_user_id || !to_user_id) {
        return res.status(400).json({
            success: false,
            message: 'البيانات المطلوبة غير كاملة'
        });
    }

    console.log(`📨 دعوة من المستخدم ${from_user_id} إلى ${to_user_id} للعبة ${gameId}`);

    // التحقق من عدم وجود دعوة معلقة بالفعل
    db.get(
        `SELECT id FROM game_invites WHERE game_id = ? AND to_user_id = ? AND status = 'pending'`,
        [gameId, to_user_id],
        (err, invite) => {
            if (invite) {
                return res.status(400).json({
                    success: false,
                    message: 'يوجد دعوة معلقة بالفعل لهذا اللاعب'
                });
            }

            // إدراج دعوة جديدة
            db.run(
                `INSERT INTO game_invites (game_id, from_user_id, to_user_id, status) VALUES (?, ?, ?, 'pending')`,
                [gameId, from_user_id, to_user_id],
                function(err) {
                    if (err) {
                        console.error('❌ خطأ في إنشاء الدعوة:', err.message);
                        return res.status(500).json({
                            success: false,
                            message: 'خطأ في إرسال الدعوة'
                        });
                    }

                    console.log(`✅ تم إرسال الدعوة ID: ${this.lastID}`);
                    res.json({
                        success: true,
                        message: 'تم إرسال الدعوة بنجاح',
                        inviteId: this.lastID
                    });
                }
            );
        }
    );
});

// API للرد على الدعوة (قبول/رفض)
app.post('/api/games/:gameId/invite-response', (req, res) => {
    const gameId = req.params.gameId;
    const { invite_id, to_user_id, response } = req.body; // response: 'accepted' أو 'rejected'

    if (!gameId || !invite_id || !to_user_id || !response) {
        return res.status(400).json({
            success: false,
            message: 'البيانات المطلوبة غير كاملة'
        });
    }

    if (response !== 'accepted' && response !== 'rejected') {
        return res.status(400).json({
            success: false,
            message: 'الرد غير صحيح'
        });
    }

    console.log(`🎯 الرد على الدعوة ID: ${invite_id} - الرد: ${response}`);

    // تحديث الدعوة
    db.run(
        `UPDATE game_invites SET status = ?, responded_at = CURRENT_TIMESTAMP WHERE id = ? AND to_user_id = ?`,
        [response, invite_id, to_user_id],
        function(err) {
            if (err) {
                console.error('❌ خطأ تحديث الدعوة:', err.message);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في تحديث الدعوة'
                });
            }

            if (response === 'accepted') {
                console.log(`✅ تم قبول الدعوة - اللاعب ${to_user_id} سينضم للعبة ${gameId}`);

                // الحصول على معلومات اللعبة الحالية
                db.get(
                    `SELECT * FROM games WHERE id = ?`,
                    [gameId],
                    (err, game) => {
                        if (err || !game) {
                            console.error('❌ خطأ جلب المباراة:', err?.message);
                            return res.status(500).json({
                                success: false,
                                message: 'خطأ في معالجة القبول'
                            });
                        }

                        // إذا كان هناك ضيف موجود، طرده أولاً
                        if (game.opponent_id && game.opponent_id !== to_user_id) {
                            const oldGuestId = game.opponent_id;
                            console.log(`👢 طرد الضيف القديم ${oldGuestId}`);

                            // حذف الضيف القديم من game_players وتعيين guest_kicked = 1
                            db.run(
                                `DELETE FROM game_players WHERE game_id = ? AND user_id = ?`,
                                [gameId, oldGuestId],
                                (delErr) => {
                                    if (delErr) {
                                        console.error('❌ خطأ حذف الضيف القديم:', delErr.message);
                                    } else {
                                        console.log(`✅ تم حذف الضيف القديم ${oldGuestId} من game_players`);
                                    }
                                }
                            );

                            // تعيين guest_kicked = 1 ليعرف الضيف القديم أنه تم طرده
                            db.run(
                                `UPDATE games SET guest_kicked = 1 WHERE id = ?`,
                                [gameId],
                                (kickErr) => {
                                    if (kickErr) {
                                        console.error('❌ خطأ تعيين guest_kicked:', kickErr.message);
                                    } else {
                                        console.log(`✅ تم تعيين guest_kicked = 1 للعبة ${gameId}`);
                                    }
                                }
                            );
                        }

                        // إضافة اللاعب الجديد كضيف
                        db.run(
                            `INSERT INTO game_players (game_id, user_id, player_side) VALUES (?, ?, 'black')`,
                            [gameId, to_user_id],
                            (insertErr) => {
                                if (insertErr) {
                                    console.error('❌ خطأ إضافة اللاعب الجديد:', insertErr.message);
                                    return res.status(500).json({
                                        success: false,
                                        message: 'خطأ في إضافة اللاعب'
                                    });
                                }

                                // تحديث opponent_id وحالة المباراة
                                db.run(
                                    `UPDATE games SET opponent_id = ?, status = 'ready' WHERE id = ?`,
                                    [to_user_id, gameId],
                                    (updateErr) => {
                                        if (updateErr) {
                                            console.error('❌ خطأ تحديث المباراة:', updateErr.message);
                                            return res.status(500).json({
                                                success: false,
                                                message: 'خطأ في تحديث المباراة'
                                            });
                                        }

                                        console.log(`✅ تم إضافة الضيف الجديد ${to_user_id} وتحديث حالة المباراة`);

                                        // إذا كان هناك ضيف قديم، حذف باقي دعواته
                                        if (game.opponent_id && game.opponent_id !== to_user_id) {
                                            db.run(
                                                `UPDATE game_invites SET status = 'rejected', responded_at = CURRENT_TIMESTAMP 
                                                 WHERE game_id = ? AND to_user_id = ? AND status = 'pending'`,
                                                [gameId, game.opponent_id],
                                                (rejectErr) => {
                                                    if (rejectErr) {
                                                        console.error('❌ خطأ رفض دعوات الضيف القديم:', rejectErr.message);
                                                    }
                                                }
                                            );
                                        }

                                        res.json({
                                            success: true,
                                            message: 'تم قبول الدعوة بنجاح',
                                            newGuestId: to_user_id,
                                            oldGuestId: game.opponent_id
                                        });
                                    }
                                );
                            }
                        );
                    }
                );
            } else {
                // الرفض
                console.log(`❌ تم رفض الدعوة - اللاعب ${to_user_id} رفض الانضمام`);
                res.json({
                    success: true,
                    message: 'تم رفض الدعوة'
                });
            }
        }
    );
});

// API للحصول على الدعوات المعلقة للاعب
app.get('/api/users/:userId/pending-invites', (req, res) => {
    const userId = req.params.userId;

    if (!userId) {
        return res.status(400).json({
            success: false,
            message: 'معرف المستخدم مطلوب'
        });
    }

    db.all(
        `SELECT gi.*, g.game_name, u.username, u.avatar_url
         FROM game_invites gi
         JOIN games g ON gi.game_id = g.id
         JOIN users u ON gi.from_user_id = u.id
         WHERE gi.to_user_id = ? 
         ORDER BY gi.created_at DESC`,
        [userId],
        (err, invites) => {
            if (err) {
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في جلب الدعوات'
                });
            }

            res.json({
                success: true,
                invites: invites || []
            });
        }
    );
});

// API لحفظ بيانات المعركة
app.post('/api/games/:gameId/save', (req, res) => {
    const gameId = req.params.gameId;
    const {
        hostName,
        hostColor,
        guestName,
        guestColor,
        mapName,
        player1,
        player2,
        isGuestUser
    } = req.body;

    if (!gameId || !player1) {
        return res.status(400).json({
            success: false,
            message: 'البيانات المطلوبة غير كاملة'
        });
    }

    // تحويل بيانات الوحدات لكل لاعب إلى JSON
    const player1UnitsJson = JSON.stringify(player1.placedUnits);
    const player1CountsJson = JSON.stringify(player1.unitCounts);
    
    const player2UnitsJson = JSON.stringify(player2?.placedUnits || []);
    const player2CountsJson = JSON.stringify(player2?.unitCounts || {});

    // إنشء كائن شامل لبيانات الحفظ
    const completeGameData = {
        hostName,
        hostColor,
        guestName,
        guestColor,
        mapName,
        player1: {
            name: player1.name,
            color: player1.color,
            unitsCount: player1.unitsCount,
            placedUnits: player1.placedUnits,
            unitCounts: player1.unitCounts
        },
        player2: {
            name: player2?.name || guestName,
            color: player2?.color || guestColor,
            unitsCount: player2?.unitsCount || 0,
            placedUnits: player2?.placedUnits || [],
            unitCounts: player2?.unitCounts || {}
        },
        isGuestUser: isGuestUser,
        savedAt: new Date().toISOString()
    };

    // حفظ البيانات الكاملة لكل لاعب في قاعدة البيانات
    db.run(
        `UPDATE games SET 
            host_name = ?,
            host_color = ?,
            guest_name = ?,
            guest_color = ?,
            map_name = ?,
            placed_units_count = ?,
            placed_units_data = ?,
            unit_counts_data = ?,
            last_saved_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
        [
            hostName,
            hostColor,
            guestName,
            guestColor,
            mapName,
            player1.unitsCount + (player2?.unitsCount || 0),
            JSON.stringify(completeGameData),
            JSON.stringify({
                player1: player1.unitCounts,
                player2: player2?.unitCounts || {}
            }),
            gameId
        ],
        function(err) {
            if (err) {
                console.error('❌ خطأ حفظ بيانات المعركة:', err.message);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في حفظ بيانات المعركة',
                    error: err.message
                });
            }

            console.log(`✅ تم حفظ بيانات المعركة ${gameId} بنجاح`);
            console.log(`   • وحدات اللاعب الأول: ${player1.unitsCount}`);
            console.log(`   • وحدات اللاعب الثاني: ${player2?.unitsCount || 0}`);
            
            res.json({
                success: true,
                message: 'تم حفظ بيانات المعركة بنجاح',
                gameId: gameId,
                player1UnitsCount: player1.unitsCount,
                player2UnitsCount: player2?.unitsCount || 0,
                totalUnitsCount: player1.unitsCount + (player2?.unitsCount || 0)
            });
        }
    );
});

// API لتحميل بيانات المعركة
app.get('/api/games/:gameId/load', (req, res) => {
    const gameId = req.params.gameId;

    if (!gameId) {
        return res.status(400).json({
            success: false,
            message: 'معرف المعركة مطلوب'
        });
    }

    db.get(
        `SELECT 
            id,
            game_name,
            host_id,
            opponent_id,
            host_name,
            host_color,
            guest_name,
            guest_color,
            map_name,
            placed_units_count,
            placed_units_data,
            unit_counts_data,
            last_saved_at
        FROM games WHERE id = ?`,
        [gameId],
        (err, game) => {
            if (err) {
                console.error('❌ خطأ تحميل بيانات المعركة:', err.message);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في تحميل بيانات المعركة'
                });
            }

            if (!game) {
                return res.status(404).json({
                    success: false,
                    message: 'لم يتم العثور على المعركة'
                });
            }

            // تحويل JSON إلى object
            let placedUnits = [];
            let unitCounts = {};

            try {
                if (game.placed_units_data) {
                    placedUnits = JSON.parse(game.placed_units_data);
                }
                if (game.unit_counts_data) {
                    unitCounts = JSON.parse(game.unit_counts_data);
                }
            } catch (parseErr) {
                console.error('❌ خطأ في تحليل بيانات الوحدات:', parseErr.message);
            }

            console.log(`✅ تم تحميل بيانات المعركة ${gameId} بنجاح`);
            res.json({
                success: true,
                message: 'تم تحميل بيانات المعركة بنجاح',
                game: {
                    id: game.id,
                    gameName: game.game_name,
                    hostName: game.host_name,
                    hostColor: game.host_color,
                    guestName: game.guest_name,
                    guestColor: game.guest_color,
                    mapName: game.map_name,
                    placedUnitsCount: game.placed_units_count,
                    placedUnits: placedUnits,
                    unitCounts: unitCounts,
                    lastSavedAt: game.last_saved_at
                }
            });
        }
    );
});

// ======= API لحفظ وجلب القطع الموضوعة =======
// تخزين مؤقت للقطع (في الذاكرة)
const gameUnits = new Map();

// حفظ القطع للعبة
app.post('/api/games/:id/units', (req, res) => {
    const gameId = req.params.id;
    const { player1Units, player2Units } = req.body;
    
    console.log(`\n${'='.repeat(50)}`);
    console.log(`💾 حفظ قطع اللعبة ${gameId}:`, {
        player1Count: player1Units?.length || 0,
        player2Count: player2Units?.length || 0
    });
    console.log(`   req.body keys:`, Object.keys(req.body));
    
    // تفاصيل الوحدات المستقبلة
    if(player1Units && player1Units.length > 0) {
        console.log('📍 وحدات لاعب 1 المستقبلة:');
        player1Units.forEach((u, i) => {
            console.log(`  ${i+1}. ${u.type} في (${u.row}, ${u.col}) - لون: ${u.color}`);
        });
    }
    if(player2Units && player2Units.length > 0) {
        console.log('📍 وحدات لاعب 2 المستقبلة:');
        player2Units.forEach((u, i) => {
            console.log(`  ${i+1}. ${u.type} في (${u.row}, ${u.col}) - لون: ${u.color}`);
        });
    }
    
    // الحفاظ على البيانات الموجودة وتحديثها في الذاكرة (للتوافق)
    const existing = gameUnits.get(gameId) || { player1Units: [], player2Units: [] };
    
    if(player1Units && player1Units.length > 0) {
        existing.player1Units = player1Units;
    }
    if(player2Units && player2Units.length > 0) {
        existing.player2Units = player2Units;
    }
    
    gameUnits.set(gameId, existing);
    
    // حفظ القطع في قاعدة البيانات
    const allUnits = [];
    
    // معجم لترجمة أنواع القطع للعربية
    const pieceNames = {
        'infantry': 'جندي مشاة',
        'knight': 'فارس',
        'archer': 'رامي',
        'queen': 'وزير',
        'king': 'القائد',
        'ship': 'مركب',
        'pawn': 'جندي مشاة'
    };
    
    // إضافة قطع اللاعب 1
    if(player1Units && player1Units.length > 0) {
        player1Units.forEach((unit, index) => {
            const baseName = pieceNames[unit.type] || unit.type;
            const pieceName = `${baseName} (${index + 1})`;
            allUnits.push({
                game_id: gameId,
                piece_name: pieceName,
                piece_type: unit.type,
                row: unit.row,
                col: unit.col,
                color: unit.color || 'white',
                player_number: 1,
                html_content: unit.html
            });
        });
    }
    
    // إضافة قطع اللاعب 2
    if(player2Units && player2Units.length > 0) {
        player2Units.forEach((unit, index) => {
            const baseName = pieceNames[unit.type] || unit.type;
            const pieceName = `${baseName} (${index + 1})`;
            allUnits.push({
                game_id: gameId,
                piece_name: pieceName,
                piece_type: unit.type,
                row: unit.row,
                col: unit.col,
                color: unit.color || 'black',
                player_number: 2,
                html_content: unit.html
            });
        });
    }
    
    // تفاصيل مفصلة عن الوحدات قبل الحفظ
    console.log('🔍 تفاصيل الوحدات قبل حفظها في قاعدة البيانات:');
    allUnits.forEach((u, i) => {
        console.log(`  [${i+1}] ${u.piece_name} | النوع: ${u.piece_type} | الموقع: (${u.row}, ${u.col}) | اللون: ${u.color} | اللاعب: ${u.player_number}`);
    });
    
    if(allUnits.length === 0) {
        console.log('ℹ️ لا توجد قطع للحفظ');
        return res.json({ success: true, message: 'تم حفظ القطع بنجاح' });
    }
    
    // ⚠️ حذف فقط قطع اللاعبين الذين يرسلون وحدات جديدة
    // لتجنب فقدان وحدات اللاعب الآخر
    const playerNumbers = [...new Set(allUnits.map(u => u.player_number))];
    const placeholders = playerNumbers.map(() => '?').join(',');
    
    console.log(`🗑️ حذف القطع القديمة لـ: players ${playerNumbers.join(', ')} من اللعبة ${gameId}`);
    
    db.run(
        `DELETE FROM game_pieces WHERE game_id = ? AND player_number IN (${placeholders})`,
        [gameId, ...playerNumbers],
        (deleteErr) => {
            if(deleteErr) {
                console.error('❌ خطأ في حذف القطع القديمة:', deleteErr);
                return res.json({ success: false, message: 'خطأ في حذف القطع القديمة' });
            }
            
            console.log(`✅ تم حذف القطع القديمة للعبة ${gameId}`);
            
            let savedCount = 0;
            let errorCount = 0;
            const errors = [];

            allUnits.forEach((unit, unitIndex) => {
                console.log(`  💾 حفظ وحدة [${unitIndex+1}]: ${unit.piece_type} في (${unit.row}, ${unit.col}) - لاعب ${unit.player_number}`);
                
                db.run(
                    `INSERT INTO game_pieces (game_id, piece_name, piece_type, row, col, color, player_number, html_content)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        unit.game_id,
                        unit.piece_name,
                        unit.piece_type,
                        unit.row,
                        unit.col,
                        unit.color,
                        unit.player_number,
                        unit.html_content
                    ],
                    function(err) {
                        if(err) {
                            console.error(`❌ خطأ في حفظ وحدة [${unitIndex+1}]:`, err.message);
                            errorCount++;
                            errors.push(err.message);
                        } else {
                            console.log(`✅ تم حفظ وحدة [${unitIndex+1}] بنجاح`);
                            savedCount++;
                        }
                        
                        // عندما ننتهي من جميع الوحدات
                        if(savedCount + errorCount === allUnits.length) {
                            console.log(`\n🎯 ملخص الحفظ:`);
                            console.log(`  ✅ نجح: ${savedCount} وحدة`);
                            console.log(`  ❌ فشل: ${errorCount} وحدة`);
                            console.log(`  🎮 لاعب 1: ${allUnits.filter(u => u.player_number === 1).length} وحدة`);
                            console.log(`  🎮 لاعب 2: ${allUnits.filter(u => u.player_number === 2).length} وحدة`);
                            
                            if(errorCount > 0) {
                                console.error('  الأخطاء:', errors);
                            }
                            
                            res.json({
                                success: errorCount === 0,
                                message: `تم حفظ ${savedCount} قطع بنجاح`,
                                savedCount: savedCount,
                                failedCount: errorCount,
                                errors: errors.length > 0 ? errors : undefined
                            });
                        }
                    }
                );
            });
        }
    );
});

// جلب القطع للعبة
app.get('/api/games/:id/units', (req, res) => {
    const gameId = req.params.id;
    
    // جلب من قاعدة البيانات
    db.all('SELECT * FROM game_pieces WHERE game_id = ? ORDER BY player_number, id', [gameId], (err, rows) => {
        if(err) {
            console.error('❌ خطأ في جلب القطع من قاعدة البيانات:', err);
            // محاولة الجلب من الذاكرة كبديل
            const units = gameUnits.get(gameId) || { player1Units: [], player2Units: [] };
            return res.json({
                success: true,
                units: {
                    player1Units: units.player1Units || [],
                    player2Units: units.player2Units || []
                },
                source: 'memory'
            });
        }
        
        // تجميع القطع حسب اللاعب
        const player1Units = [];
        const player2Units = [];
        
        console.log(`\n🔍 تفاصيل القطع المسترجعة من قاعدة البيانات للعبة ${gameId}:`);
        console.log(`  العدد الكلي: ${rows.length} قطعة`);
        
        rows.forEach(row => {
            const unit = {
                id: row.id,
                name: row.piece_name,
                type: row.piece_type,
                row: row.row,
                col: row.col,
                color: row.color,
                html: row.html_content
            };
            
            console.log(`  [${row.id}] ${row.piece_type} في (${row.row}, ${row.col}) - لون: ${row.color} - لاعب: ${row.player_number}`);
            
            if(row.player_number === 1) {
                player1Units.push(unit);
            } else if(row.player_number === 2) {
                player2Units.push(unit);
            }
        });
        
        console.log(`📥 تم جلب قطع اللعبة ${gameId} من قاعدة البيانات:`, {
            player1Count: player1Units.length,
            player2Count: player2Units.length
        });
        
        // تفاصيل الوحدات المسترجعة
        if(player1Units.length > 0) {
            console.log('📍 وحدات لاعب 1 المسترجعة:');
            player1Units.forEach(u => {
                console.log(`  • ${u.type} في (${u.row}, ${u.col}) - لون: ${u.color}`);
            });
        }
        if(player2Units.length > 0) {
            console.log('📍 وحدات لاعب 2 المسترجعة:');
            player2Units.forEach(u => {
                console.log(`  • ${u.type} في (${u.row}, ${u.col}) - لون: ${u.color}`);
            });
        }
        
        res.json({
            success: true,
            units: {
                player1Units: player1Units,
                player2Units: player2Units
            },
            source: 'database',
            totalPieces: rows.length
        });
    });
});

// ✅ Endpoint لتسجيل بداية مرحلة التوزيع
app.post('/api/games/:id/start-distribution', (req, res) => {
    const gameId = req.params.id;
    const { armyDistributionTime } = req.body;
    
    console.log(`📤 استقبال طلب start-distribution للعبة ${gameId}`);
    console.log(`   armyDistributionTime من الطلب:`, armyDistributionTime);
    console.log(`   req.body:`, req.body);
    
    // التأكد من القيمة
    const totalDistributionMinutes = (armyDistributionTime && armyDistributionTime > 0) ? parseInt(armyDistributionTime) : 2;
    const totalDistributionSeconds = totalDistributionMinutes * 60;
    
    console.log(`   ✅ زمن التوزيع المستخدم: ${totalDistributionMinutes} دقيقة (${totalDistributionSeconds} ثانية)`);
    
    // إذا لم تبدأ بعد، احفظ وقت البداية الآن
    if(!gameDistributionStartTimes.has(gameId)) {
        const startTime = new Date();
        gameDistributionStartTimes.set(gameId, {
            startTime: startTime,
            totalSeconds: totalDistributionSeconds
        });
        console.log(`✅ تم تسجيل بداية التوزيع للعبة ${gameId} في ${startTime.toISOString()}`);
        console.log(`⏱️  زمن التوزيع: ${totalDistributionMinutes} دقيقة (${totalDistributionSeconds} ثانية)`);
        
        return res.json({
            success: true,
            message: 'تم تسجيل بداية التوزيع',
            distributionStartedAt: startTime.toISOString(),
            totalDistributionSeconds: totalDistributionSeconds,
            totalDistributionMinutes: totalDistributionMinutes
        });
    } else {
        // بالفعل تم تسجيل البداية
        const data = gameDistributionStartTimes.get(gameId);
        console.log(`ℹ️  بداية التوزيع للعبة ${gameId} مسجلة بالفعل في ${data.startTime.toISOString()}`);
        console.log(`⏱️  زمن التوزيع المسجل: ${data.totalSeconds / 60} دقيقة`);
        
        return res.json({
            success: true,
            message: 'بداية التوزيع مسجلة بالفعل',
            distributionStartedAt: data.startTime.toISOString(),
            totalDistributionSeconds: data.totalSeconds,
            totalDistributionMinutes: data.totalSeconds / 60
        });
    }
});

// ✅ Endpoint لإرجاع الوقت المركزي للعبة (يعتمد على وقت بداية التوزيع الفعلي وزمن التوزيع)
app.get('/api/games/:id/server-time', (req, res) => {
    const gameId = req.params.id;
    const currentTime = new Date();
    
    // احصل على وقت بداية التوزيع
    const distributionData = gameDistributionStartTimes.get(gameId);
    
    if(!distributionData) {
        // إذا لم يتم تسجيل البداية بعد، استخدم 2 دقيقة كافتراضي
        return res.json({
            success: false,
            message: 'لم تبدأ مرحلة التوزيع بعد',
            serverTime: currentTime.toISOString(),
            remainingSeconds: 2 * 60, // 2 دقيقة كافتراضي
            totalDistributionSeconds: 2 * 60,
            elapsedSeconds: 0
        });
    }
    
    const distributionStartTime = distributionData.startTime;
    const totalDistributionSeconds = distributionData.totalSeconds;
    
    const elapsedMs = currentTime - distributionStartTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    
    const remainingSeconds = Math.max(0, totalDistributionSeconds - elapsedSeconds);
    
    console.log(`⏱️  الوقت المركزي للعبة ${gameId}:`);
    console.log(`  • بداية التوزيع: ${distributionStartTime.toISOString()}`);
    console.log(`  • الوقت الحالي: ${currentTime.toISOString()}`);
    console.log(`  • الوقت المنقضي: ${elapsedSeconds} ثانية`);
    console.log(`  • إجمالي التوزيع: ${totalDistributionSeconds} ثانية`);
    console.log(`  • الوقت المتبقي: ${remainingSeconds} ثانية`);
    
    res.json({
        success: true,
        serverTime: currentTime.toISOString(),
        distributionStartedAt: distributionStartTime.toISOString(),
        elapsedSeconds: elapsedSeconds,
        remainingSeconds: remainingSeconds,
        totalDistributionSeconds: totalDistributionSeconds,
        totalDistributionMinutes: totalDistributionSeconds / 60,
        isTimeUp: remainingSeconds <= 0
    });
});

// ========== API لإدارة أدوار القتال ==========

// 🎮 بدء مرحلة القتال
app.post('/api/games/:id/start-battle', (req, res) => {
    const gameId = req.params.id;
    const { turnTimeSeconds } = req.body;
    
    const currentTime = new Date();
    const turnTime = turnTimeSeconds || 120; // افتراضي 2 دقيقة
    
    // حفظ بيانات الدور الأول (الضيف يبدأ)
    gameBattleTurns.set(gameId, {
        currentTurn: 'guest',
        turnStartTime: currentTime,
        turnTimeSeconds: turnTime
    });
    
    console.log(`⚔️ بدأت مرحلة القتال للعبة ${gameId}`);
    console.log(`  • الدور الأول: guest`);
    console.log(`  • زمن كل دور: ${turnTime} ثانية`);
    
    res.json({
        success: true,
        message: 'بدأت مرحلة القتال',
        currentTurn: 'guest',
        turnTimeSeconds: turnTime,
        turnStartedAt: currentTime.toISOString()
    });
});

// 📊 جلب معلومات الدور الحالي والوقت المتبقي
app.get('/api/games/:id/battle-turn', (req, res) => {
    const gameId = req.params.id;
    const currentTime = new Date();
    
    const battleData = gameBattleTurns.get(gameId);
    
    if(!battleData) {
        return res.json({
            success: false,
            message: 'لم تبدأ مرحلة القتال بعد',
            serverTime: currentTime.toISOString()
        });
    }
    
    const { currentTurn, turnStartTime, turnTimeSeconds } = battleData;
    
    const elapsedMs = currentTime - turnStartTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const remainingSeconds = Math.max(0, turnTimeSeconds - elapsedSeconds);
    
    console.log(`⏱️  الدور الحالي للعبة ${gameId}:`);
    console.log(`  • اللاعب: ${currentTurn}`);
    console.log(`  • بداية الدور: ${turnStartTime.toISOString()}`);
    console.log(`  • الوقت المنقضي: ${elapsedSeconds} ثانية`);
    console.log(`  • الوقت المتبقي: ${remainingSeconds} ثانية`);
    
    res.json({
        success: true,
        currentTurn: currentTurn,
        serverTime: currentTime.toISOString(),
        turnStartedAt: turnStartTime.toISOString(),
        elapsedSeconds: elapsedSeconds,
        remainingSeconds: remainingSeconds,
        turnTimeSeconds: turnTimeSeconds,
        isTimeUp: remainingSeconds <= 0
    });
});

// 🔄 تبديل الدور
app.post('/api/games/:id/switch-turn', (req, res) => {
    const gameId = req.params.id;
    const currentTime = new Date();
    
    const battleData = gameBattleTurns.get(gameId);
    
    if(!battleData) {
        return res.status(400).json({
            success: false,
            message: 'لم تبدأ مرحلة القتال بعد'
        });
    }
    
    // تبديل الدور
    const newTurn = battleData.currentTurn === 'guest' ? 'host' : 'guest';
    
    // تحديث البيانات
    battleData.currentTurn = newTurn;
    battleData.turnStartTime = currentTime;
    gameBattleTurns.set(gameId, battleData);
    
    console.log(`🔄 تبديل الدور في اللعبة ${gameId} إلى: ${newTurn}`);
    
    res.json({
        success: true,
        message: 'تم تبديل الدور',
        currentTurn: newTurn,
        turnStartedAt: currentTime.toISOString(),
        turnTimeSeconds: battleData.turnTimeSeconds
    });
});

// ========== API لنظام الشات ==========

// 📨 إرسال رسالة جديدة
app.post('/api/messages/send', authenticateToken, (req, res) => {
    const senderId = req.user.id;
    const { recipientIds, messageText, isGroupChat, chatId: providedChatId } = req.body;

    console.log(`\n💬 رسالة جديدة من المستخدم ${senderId}`);

    if (!messageText || !Array.isArray(recipientIds) || recipientIds.length === 0) {
        console.error('❌ البيانات المطلوبة غير كاملة');
        return res.status(400).json({
            success: false,
            message: 'نص الرسالة والمستقبلون مطلوبان'
        });
    }

    // إنشاء chat_id فريد
    let chatId;
    if (isGroupChat) {
        if (providedChatId) {
            chatId = providedChatId;
            console.log(`👥 محادثة جماعية (موجودة): ${chatId}`);
        } else {
            // لمحادثات المجموعة: group_timestamp_creatorId
            chatId = `group_${Date.now()}_${senderId}`;
            console.warn('⚠️ لم يتم إرسال chatId للمجموعة، تم إنشاء معرف جديد:', chatId);
        }
    } else {
        // للمحادثات الخاصة: user_minId_maxId
        const minId = Math.min(senderId, recipientIds[0]);
        const maxId = Math.max(senderId, recipientIds[0]);
        chatId = `user_${minId}_${maxId}`;
        console.log(`👤 محادثة خاصة: ${chatId}`);
    }

    const recipientIdsStr = recipientIds.join(',');

    db.run(
        `INSERT INTO messages (chat_id, sender_id, recipient_ids, message_text, is_group_chat) 
         VALUES (?, ?, ?, ?, ?)`,
        [chatId, senderId, recipientIdsStr, messageText, isGroupChat ? 1 : 0],
        function(err) {
            if (err) {
                console.error('❌ خطأ في حفظ الرسالة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في إرسال الرسالة'
                });
            }

            console.log(`✅ تم حفظ الرسالة ID: ${this.lastID}`);
            console.log(`   المستقبلون: ${recipientIds.join(', ')}`);
            console.log(`   النص: ${messageText.substring(0, 50)}...`);

            res.json({
                success: true,
                message: 'تم إرسال الرسالة بنجاح',
                messageId: this.lastID,
                chatId: chatId
            });
        }
    );
});

// � الحصول على الرسائل الجديدة/غير المقروءة (يجب أن يكون قبل /:chatId)
app.get('/api/messages/unread', authenticateToken, (req, res) => {
    const userId = req.user.id;

    console.log(`\n📬 جاري البحث عن الرسائل الجديدة للمستخدم ${userId}`);

    // أولاً: تحديث الرسائل القديمة التي بدون read_status
    db.run(
        `UPDATE messages SET read_status = 'unread' WHERE read_status IS NULL OR read_status = ''`,
        function(err) {
            if (err) {
                console.error('⚠️ تنبيه: خطأ في تحديث الرسائل القديمة:', err);
            } else if (this.changes > 0) {
                console.log(`⚙️ تم تحديث ${this.changes} رسالة قديمة إلى unread`);
            }
        }
    );

    // الآن: البحث عن الرسائل الجديدة (فردية وجماعية)
    const query = `
    SELECT m.*, u.username, u.avatar_url, m.is_group_chat,
           gc.group_name, gc.member_ids as group_member_ids,
           CASE 
               WHEN m.is_group_chat = 1 THEN gc.group_name
               ELSE u.username
           END as displayName
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    LEFT JOIN group_chats gc ON m.chat_id = gc.chat_id
    WHERE (
        m.recipient_ids LIKE ? OR 
        m.recipient_ids LIKE ? OR 
        m.recipient_ids = ?
    )
    AND m.read_status = 'unread'
    AND m.sender_id != ?
    ORDER BY m.created_at DESC
    `;

    const userIdStr = userId.toString();
    const params = [
        `${userIdStr},%`,        // 3,1,4 (في البداية)
        `%,${userIdStr},%`,      // 1,3,4 (في المنتصف)
        userIdStr                 // 3 (الوحيد)
    ];

    db.all(query, [...params, userIdStr], (err, rows) => {
        if (err) {
            console.error('❌ خطأ في البحث عن الرسائل الجديدة:', err);
            console.error('الاستعلام:', query);
            console.error('المعاملات:', params);
            return res.status(500).json({
                success: false,
                message: 'خطأ في البحث عن الرسائل'
            });
        }

        console.log(`✅ وجدنا ${rows ? rows.length : 0} رسالة جديدة`);
        if (rows && rows.length > 0) {
            rows.forEach(msg => {
                const displayName = msg.displayName || msg.username || 'غير معروف';
                console.log(`   - من ${displayName} (ID ${msg.sender_id}): "${msg.message_text.substring(0, 30)}..."`);
            });
        }

        res.json({
            success: true,
            unreadMessages: rows || [],
            count: rows ? rows.length : 0
        });
    });
});

// �📥 جلب رسائل محادثة معينة
// 📋 جلب مجموعات المستخدم الحالي
app.get('/api/messages/groups', authenticateToken, (req, res) => {
    const userId = req.user.id;

    const userIdStr = userId.toString();
    // البحث عن المستخدم في أي موضع من member_ids
    // نضيف فاصلة في الطرفين عند البحث لضمان التطابق الدقيق
    const likePattern = `%,${userIdStr},%`;

    console.log(`\n📋 جاري البحث عن المجموعات للمستخدم ${userId}`);
    console.log(`   نمط البحث: ${likePattern}`);

    db.all(
        `SELECT chat_id, group_name, creator_id, member_ids, created_at
         FROM group_chats
         WHERE (
             (',' || member_ids || ',') LIKE ?
         )
         ORDER BY created_at DESC`,
        [likePattern],
        (err, rows) => {
            if (err) {
                console.error('❌ خطأ في جلب المجموعات:', err);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في جلب المجموعات'
                });
            }

            console.log(`✅ تم العثور على ${rows ? rows.length : 0} مجموعة`);
            if (rows && rows.length > 0) {
                console.log(`   المجموعات: ${rows.map(r => r.group_name).join(', ')}`);
            }

            res.json({
                success: true,
                groups: rows || []
            });
        }
    );
});

// 🚪 مغادرة/حذف مجموعة للمستخدم الحالي
app.delete('/api/messages/groups/:chatId/leave', authenticateToken, (req, res) => {
    const userId = req.user.id;
    const chatId = req.params.chatId;

    db.get(
        `SELECT member_ids FROM group_chats WHERE chat_id = ?`,
        [chatId],
        (err, row) => {
            if (err) {
                console.error('❌ خطأ في جلب بيانات المجموعة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في جلب بيانات المجموعة'
                });
            }

            if (!row) {
                return res.status(404).json({
                    success: false,
                    message: 'المجموعة غير موجودة'
                });
            }

            const members = row.member_ids
                .split(',')
                .map(id => parseInt(id.trim(), 10))
                .filter(id => !Number.isNaN(id));

            const updatedMembers = members.filter(id => id !== userId);

            if (updatedMembers.length === 0) {
                db.run(
                    `DELETE FROM group_chats WHERE chat_id = ?`,
                    [chatId],
                    function(deleteErr) {
                        if (deleteErr) {
                            console.error('❌ خطأ في حذف المجموعة:', deleteErr);
                            return res.status(500).json({
                                success: false,
                                message: 'خطأ في حذف المجموعة'
                            });
                        }

                        db.run(
                            `DELETE FROM messages WHERE chat_id = ?`,
                            [chatId]
                        );

                        return res.json({
                            success: true,
                            message: 'تم حذف المجموعة'
                        });
                    }
                );
            } else {
                const updatedMembersStr = updatedMembers.join(',');
                db.run(
                    `UPDATE group_chats SET member_ids = ? WHERE chat_id = ?`,
                    [updatedMembersStr, chatId],
                    function(updateErr) {
                        if (updateErr) {
                            console.error('❌ خطأ في تحديث أعضاء المجموعة:', updateErr);
                            return res.status(500).json({
                                success: false,
                                message: 'خطأ في تحديث المجموعة'
                            });
                        }

                        return res.json({
                            success: true,
                            message: 'تمت مغادرة المجموعة'
                        });
                    }
                );
            }
        }
    );
});

app.get('/api/messages/:chatId', authenticateToken, (req, res) => {
    const chatId = req.params.chatId;
    const userId = req.user.id;

    console.log(`\n📖 جلب رسائل المحادثة: ${chatId}`);

    db.all(
        `SELECT 
            m.id, m.chat_id, m.sender_id, m.message_text, 
            m.message_type, m.is_group_chat, m.created_at, m.read_status,
            u.username, u.avatar_url
         FROM messages m
         JOIN users u ON m.sender_id = u.id
         WHERE m.chat_id = ? 
         ORDER BY m.created_at ASC`,
        [chatId],
        (err, messages) => {
            if (err) {
                console.error('❌ خطأ في جلب الرسائل:', err);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في جلب الرسائل'
                });
            }

            console.log(`✅ تم جلب ${messages.length} رسالة من المحادثة ${chatId}`);

            res.json({
                success: true,
                messages: messages || [],
                chatId: chatId
            });
        }
    );
});

// 📋 جلب قائمة المحادثات للمستخدم الحالي
app.get('/api/messages/conversations', authenticateToken, (req, res) => {
    const userId = req.user.id;

    console.log(`\n📋 جلب المحادثات للمستخدم ${userId}`);

    db.all(
        `SELECT DISTINCT 
            m.chat_id, 
            m.is_group_chat,
            MAX(m.created_at) as last_message_time,
            m.message_text as last_message,
            (SELECT COUNT(*) FROM messages WHERE chat_id = m.chat_id AND read_status = 'unread') as unread_count,
            (SELECT GROUP_CONCAT(DISTINCT u.username) FROM messages m2 
                JOIN users u ON m2.sender_id = u.id 
                WHERE m2.chat_id = m.chat_id LIMIT 5) as participants
         FROM messages m
         WHERE m.sender_id = ? OR instr(m.recipient_ids, ?)
         GROUP BY m.chat_id
         ORDER BY last_message_time DESC`,
        [userId, userId],
        (err, conversations) => {
            if (err) {
                console.error('❌ خطأ في جلب المحادثات:', err);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في جلب المحادثات'
                });
            }

            console.log(`✅ تم جلب ${conversations.length} محادثة`);

            res.json({
                success: true,
                conversations: conversations || [],
                userId: userId
            });
        }
    );
});

// ✅ تحديث حالة الرسالة إلى مقروءة
app.put('/api/messages/:messageId/read', authenticateToken, (req, res) => {
    const messageId = req.params.messageId;
    const userId = req.user.id;

    console.log(`\n✅ تحديث حالة الرسالة ${messageId} إلى مقروءة`);

    db.run(
        `UPDATE messages SET read_status = 'read' WHERE id = ?`,
        [messageId],
        function(err) {
            if (err) {
                console.error('❌ خطأ في تحديث الرسالة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في تحديث حالة الرسالة'
                });
            }

            console.log(`✅ تم تحديث حالة الرسالة ${messageId}`);

            res.json({
                success: true,
                message: 'تم تحديث حالة الرسالة',
                messageId: messageId
            });
        }
    );
});

// 👥 إنشاء محادثة جماعية جديدة
app.post('/api/messages/group/create', authenticateToken, (req, res) => {
    const creatorId = req.user.id;
    const { participantIds, groupName } = req.body;

    console.log(`\n👥 إنشاء محادثة جماعية جديدة`);
    console.log(`   المنشئ: ${creatorId}`);
    console.log(`   المشاركون: ${participantIds.join(', ')}`);
    console.log(`   اسم المجموعة: ${groupName}`);

    if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
        return res.status(400).json({
            success: false,
            message: 'قائمة المشاركين مطلوبة'
        });
    }

    // التأكد من أن المنشئ في المجموعة
    if (!participantIds.includes(creatorId)) {
        participantIds.push(creatorId);
    }

    // إنشاء معرف فريد للمجموعة
    const groupChatId = `group_${Date.now()}_${creatorId}`;
    const participantsStr = [...new Set(participantIds)].join(',');

    // حفظ معلومات المجموعة في الجدول الجديد
    db.run(
        `INSERT INTO group_chats (chat_id, group_name, creator_id, member_ids) 
         VALUES (?, ?, ?, ?)`,
        [groupChatId, groupName, creatorId, participantsStr],
        function(err) {
            if (err) {
                console.error('❌ خطأ في حفظ معلومات المجموعة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في إنشاء المجموعة'
                });
            }

            console.log(`✅ تم إنشاء المجموعة ${groupChatId} بنجاح`);

            res.json({
                success: true,
                message: 'تم إنشاء المحادثة الجماعية',
                chatId: groupChatId,
                participants: participantsStr.split(',').map(Number),
                groupName: groupName || `مجموعة من ${participantsStr.split(',').length} أشخاص`
            });
        }
    );

    });

// � الحصول على الرسائل الجديدة/غير المقروءة
app.get('/api/messages/unread', authenticateToken, (req, res) => {
    const userId = req.user.id;

    console.log(`\n📬 جاري البحث عن الرسائل الجديدة للمستخدم ${userId}`);

    // أولاً: تحديث الرسائل القديمة التي بدون read_status
    db.run(
        `UPDATE messages SET read_status = 'unread' WHERE read_status IS NULL OR read_status = ''`,
        function(err) {
            if (err) {
                console.error('⚠️ تنبيه: خطأ في تحديث الرسائل القديمة:', err);
            } else if (this.changes > 0) {
                console.log(`⚙️ تم تحديث ${this.changes} رسالة قديمة إلى unread`);
            }
        }
    );

    // الآن: البحث عن الرسائل الجديدة (فردية وجماعية)
    const query = `
    SELECT m.*, u.username, u.avatar_url, m.is_group_chat,
           gc.group_name, gc.member_ids as group_member_ids,
           CASE 
               WHEN m.is_group_chat = 1 THEN gc.group_name
               ELSE u.username
           END as displayName
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    LEFT JOIN group_chats gc ON m.chat_id = gc.chat_id
    WHERE (
        m.recipient_ids LIKE ? OR 
        m.recipient_ids LIKE ? OR 
        m.recipient_ids = ?
    )
    AND m.read_status = 'unread'
    AND m.sender_id != ?
    ORDER BY m.created_at DESC
    `;

    const userIdStr = userId.toString();
    const params = [
        `${userIdStr},%`,        // 3,1,4 (في البداية)
        `%,${userIdStr},%`,      // 1,3,4 (في المنتصف)
        userIdStr                 // 3 (الوحيد)
    ];

    db.all(query, [...params, userIdStr], (err, rows) => {
        if (err) {
            console.error('❌ خطأ في البحث عن الرسائل الجديدة:', err);
            console.error('الاستعلام:', query);
            console.error('المعاملات:', params);
            return res.status(500).json({
                success: false,
                message: 'خطأ في البحث عن الرسائل'
            });
        }

        console.log(`✅ وجدنا ${rows ? rows.length : 0} رسالة جديدة`);
        if (rows && rows.length > 0) {
            rows.forEach(msg => {
                const displayName = msg.displayName || msg.username || 'غير معروف';
                console.log(`   - من ${displayName} (ID ${msg.sender_id}): "${msg.message_text.substring(0, 30)}..."`);
            });
        }

        res.json({
            success: true,
            unreadMessages: rows || [],
            count: rows ? rows.length : 0
        });
    });
});

// �🗑️ حذف محادثة
app.delete('/api/messages/:chatId', authenticateToken, (req, res) => {
    const chatId = req.params.chatId;
    const userId = req.user.id;

    console.log(`\n🗑️ حذف المحادثة: ${chatId}`);

    db.run(
        `DELETE FROM messages WHERE chat_id = ? AND (sender_id = ? OR instr(recipient_ids, ?))`,
        [chatId, userId, userId],
        function(err) {
            if (err) {
                console.error('❌ خطأ في حذف المحادثة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في حذف المحادثة'
                });
            }

            console.log(`✅ تم حذف ${this.changes} رسالة من المحادثة`);

            res.json({
                success: true,
                message: 'تم حذف المحادثة',
                deletedMessages: this.changes
            });
        }
    );
});

// 🆕 API لحفظ إحصائيات اللاعب
app.post('/api/statistics/save', (req, res) => {
    try {
        let {
            game_id,
            user_id,
            username,
            opponent_name,
            player_role,
            result,
            battle_name,
            map_name,
            location_size,
            match_duration,
            pieces_killed,
            moves_count
        } = req.body;

        console.log('📊 البيانات الخام المستلمة:', req.body);

        // تحويل آمن للقيم الرقمية
        game_id = game_id ? parseInt(game_id) : 0;
        user_id = user_id ? parseInt(user_id) : 0;
        location_size = location_size ? parseInt(location_size) : 0;
        match_duration = match_duration ? parseInt(match_duration) : 0;
        pieces_killed = pieces_killed ? parseInt(pieces_killed) : 0;
        moves_count = moves_count ? parseInt(moves_count) : 0;

        // التحقق من القيم المطلوبة
        if (!game_id || !result) {
            console.error('❌ بيانات مفقودة: game_id=' + game_id + ', result=' + result);
            return res.status(400).json({
                success: false,
                message: 'بيانات مفقودة (game_id, result)'
            });
        }

        username = username || 'اللاعب';
        opponent_name = opponent_name || 'الخصم';
        player_role = player_role || 'unknown';
        battle_name = battle_name || 'معركة';
        map_name = map_name || 'خريطة';

        const insertStatistics = () => {
            console.log('📊 حفظ إحصائيات اللاعب:', {
                game_id,
                user_id,
                username,
                player_role,
                result
            });

            // حساب الفوز/خسارة/تعادل
            let wins = 0, losses = 0, draws = 0;
            if (result === 'win') wins = 1;
            else if (result === 'loss') losses = 1;
            else if (result === 'draw') draws = 1;

            const sql = `INSERT INTO player_statistics (
                game_id, user_id, username, opponent_name, player_role,
                result, battle_name, map_name, location_size, match_duration,
                pieces_killed, moves_count, wins, losses, draws
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

            const params = [
                game_id, user_id, username, opponent_name, player_role,
                result, battle_name, map_name, location_size, match_duration,
                pieces_killed, moves_count, wins, losses, draws
            ];

            console.log('🔍 معاملات SQL:', params);

            db.run(sql, params, function(err) {
                if (err) {
                    console.error('❌ خطأ في حفظ الإحصائيات:', err.message);
                    console.error('SQL:', sql);
                    console.error('Params:', params);
                    return res.status(500).json({
                        success: false,
                        message: 'فشل حفظ الإحصائيات: ' + err.message,
                        error: err.message
                    });
                }

                console.log('✅ تم حفظ إحصائيات اللاعب بنجاح - ID:', this.lastID);
                res.json({
                    success: true,
                    id: this.lastID,
                    message: 'تم حفظ الإحصائيات بنجاح'
                });
            });
        };

        // التحقق من وجود المستخدم
        db.get('SELECT id FROM users WHERE id = ?', [user_id], (userErr, userRow) => {
            if (userErr) {
                console.error('❌ خطأ في التحقق من المستخدم:', userErr);
                return res.status(500).json({
                    success: false,
                    message: 'خطأ في التحقق من المستخدم'
                });
            }
            if (!userRow) {
                return res.status(400).json({
                    success: false,
                    message: 'user_id غير صالح أو المستخدم غير موجود'
                });
            }

            // التحقق من وجود المباراة
            db.get('SELECT id FROM games WHERE id = ?', [game_id], (gameErr, gameRow) => {
                if (gameErr) {
                    console.error('❌ خطأ في التحقق من المباراة:', gameErr);
                    return res.status(500).json({
                        success: false,
                        message: 'خطأ في التحقق من المباراة'
                    });
                }

                if (gameRow) {
                    return insertStatistics();
                }

                // محاولة استخدام آخر مباراة للمستخدم إذا لم توجد المباراة الحالية
                db.get(
                    'SELECT id FROM games WHERE host_id = ? OR opponent_id = ? ORDER BY id DESC LIMIT 1',
                    [user_id, user_id],
                    (fallbackErr, fallbackRow) => {
                        if (fallbackErr) {
                            console.error('❌ خطأ في إيجاد مباراة بديلة:', fallbackErr);
                            return res.status(500).json({
                                success: false,
                                message: 'خطأ في إيجاد مباراة بديلة'
                            });
                        }

                        if (!fallbackRow) {
                            return res.status(400).json({
                                success: false,
                                message: 'game_id غير صالح أو المباراة غير موجودة'
                            });
                        }

                        game_id = fallbackRow.id;
                        console.warn('⚠️ تم استخدام مباراة بديلة لحفظ الإحصائيات:', game_id);
                        return insertStatistics();
                    }
                );
            });
        });
    } catch (err) {
        console.error('❌ خطأ عام في معالج /api/statistics/save:', err);
        res.status(500).json({
            success: false,
            message: 'خطأ خادم: ' + err.message
        });
    }
});

// 🆕 API لجلب إحصائيات لاعب معين
app.get('/api/statistics/user/:userId', (req, res) => {
    const { userId } = req.params;

    console.log('📊 جلب إحصائيات المستخدم:', userId);

    db.all(
        `SELECT 
            id, game_id, username, opponent_name, player_role,
            result, battle_name, map_name, location_size,
            match_duration, pieces_killed, moves_count,
            wins, losses, draws, created_at
        FROM player_statistics
        WHERE user_id = ?
        ORDER BY created_at DESC`,
        [userId],
        (err, rows) => {
            if (err) {
                console.error('❌ خطأ في جلب الإحصائيات:', err);
                return res.status(500).json({
                    success: false,
                    message: 'فشل جلب الإحصائيات'
                });
            }

            // حساب الإجماليات
            const totals = rows.reduce((acc, row) => {
                acc.wins += row.wins;
                acc.losses += row.losses;
                acc.draws += row.draws;
                acc.totalGames += 1;
                acc.totalPiecesKilled += row.pieces_killed || 0;
                acc.totalMoves += row.moves_count || 0;
                return acc;
            }, {
                wins: 0,
                losses: 0,
                draws: 0,
                totalGames: 0,
                totalPiecesKilled: 0,
                totalMoves: 0
            });

            console.log('✅ تم جلب إحصائيات اللاعب:', totals);
            res.json({
                success: true,
                statistics: rows,
                totals
            });
        }
    );
});

// 🆕 API لجلب إحصائيات مباراة معينة
app.get('/api/statistics/game/:gameId', (req, res) => {
    const { gameId } = req.params;

    console.log('📊 جلب إحصائيات المباراة:', gameId);

    db.all(
        `SELECT 
            id, user_id, username, opponent_name, player_role,
            result, battle_name, map_name, location_size,
            match_duration, pieces_killed, moves_count,
            wins, losses, draws, created_at
        FROM player_statistics
        WHERE game_id = ?
        ORDER BY player_role`,
        [gameId],
        (err, rows) => {
            if (err) {
                console.error('❌ خطأ في جلب إحصائيات المباراة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'فشل جلب إحصائيات المباراة'
                });
            }

            console.log('✅ تم جلب إحصائيات المباراة');
            res.json({
                success: true,
                statistics: rows
            });
        }
    );
});

// 🆕 API لحفظ نتيجة مباراة بطولة
app.post('/api/tournaments/:tournamentId/matches/:matchNumber/result', (req, res) => {
    const { tournamentId, matchNumber } = req.params;
    const { winnerId, loserId, winnerName, loserName, winnerRole, reason, gameId } = req.body;

    console.log('🏆 حفظ نتيجة مباراة بطولة:', {
        tournamentId,
        matchNumber,
        winnerId,
        loserId,
        winnerName,
        loserName,
        winnerRole,
        reason,
        gameId
    });
    
    // ⚠️ تتبع بيانات الاستقبال من الخادم
    console.log('📥 البيانات المستقبلة من الكلاينت:');
    console.log('  - winnerId من الطلب:', winnerId, '| تنوع البيانات:', typeof winnerId);
    console.log('  - loserId من الطلب:', loserId, '| تنوع البيانات:', typeof loserId);
    console.log('  - winnerRole:', winnerRole);
    console.log('  - kاملة req.body:', req.body);

    // التحقق من البيانات المطلوبة
    if (!tournamentId || !matchNumber || !winnerId || !loserId || !winnerName || !loserName || !winnerRole) {
        return res.status(400).json({
            success: false,
            message: 'بيانات مفقودة'
        });
    }

    // حفظ النتيجة في قاعدة البيانات (استبدال إذا كانت موجودة)
    db.run(
        `INSERT INTO tournament_results (
            tournament_id, match_number, game_id, winner_id, loser_id,
            winner_name, loser_name, winner_role, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tournament_id, match_number) 
        DO UPDATE SET
            game_id = excluded.game_id,
            winner_id = excluded.winner_id,
            loser_id = excluded.loser_id,
            winner_name = excluded.winner_name,
            loser_name = excluded.loser_name,
            winner_role = excluded.winner_role,
            reason = excluded.reason,
            created_at = CURRENT_TIMESTAMP`,
        [tournamentId, matchNumber, gameId, winnerId, loserId, winnerName, loserName, winnerRole, reason],
        function(err) {
            if (err) {
                console.error('❌ خطأ في حفظ نتيجة البطولة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'فشل حفظ نتيجة البطولة'
                });
            }

            console.log('✅ تم حفظ نتيجة البطولة بنجاح');
            res.json({
                success: true,
                message: 'تم حفظ النتيجة بنجاح',
                resultId: this.lastID
            });
        }
    );
});

// 🆕 API لجلب نتائج بطولة معينة
app.get('/api/tournaments/:tournamentId/results', (req, res) => {
    const { tournamentId } = req.params;

    console.log('📊 جلب نتائج البطولة:', tournamentId);

    db.all(
        `SELECT 
            id, tournament_id, match_number, game_id,
            winner_id, loser_id, winner_name, loser_name,
            winner_role, reason, created_at
        FROM tournament_results
        WHERE tournament_id = ?
        ORDER BY match_number`,
        [tournamentId],
        (err, rows) => {
            if (err) {
                console.error('❌ خطأ في جلب نتائج البطولة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'فشل جلب نتائج البطولة'
                });
            }

            console.log(`✅ تم جلب ${rows.length} نتيجة من البطولة`);
            res.json({
                success: true,
                results: rows
            });
        }
    );
});

// 🆕 API لجلب نتيجة مباراة معينة في بطولة
app.get('/api/tournaments/:tournamentId/matches/:matchNumber/result', (req, res) => {
    const { tournamentId, matchNumber } = req.params;

    console.log('📊 جلب نتيجة مباراة:', { tournamentId, matchNumber });

    db.get(
        `SELECT 
            id, tournament_id, match_number, game_id,
            winner_id, loser_id, winner_name, loser_name,
            winner_role, reason, created_at
        FROM tournament_results
        WHERE tournament_id = ? AND match_number = ?`,
        [tournamentId, matchNumber],
        (err, row) => {
            if (err) {
                console.error('❌ خطأ في جلب نتيجة المباراة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'فشل جلب نتيجة المباراة'
                });
            }

            if (!row) {
                return res.json({
                    success: true,
                    result: null,
                    message: 'لا توجد نتيجة بعد'
                });
            }

            console.log('✅ تم جلب نتيجة المباراة');
            res.json({
                success: true,
                result: row
            });
        }
    );
});

// 🆕 API لحذف نتيجة مباراة معينة في بطولة (إعادة مباراة)
app.delete('/api/tournaments/:tournamentId/matches/:matchNumber/result', (req, res) => {
    const { tournamentId, matchNumber } = req.params;

    console.log('🗑️ حذف نتيجة مباراة (إعادة مباراة):', { tournamentId, matchNumber });

    db.run(
        `DELETE FROM tournament_results WHERE tournament_id = ? AND match_number = ?`,
        [tournamentId, matchNumber],
        function(err) {
            if (err) {
                console.error('❌ خطأ في حذف نتيجة المباراة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'فشل حذف نتيجة المباراة'
                });
            }

            if (this.changes === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'لا توجد نتيجة لهذه المباراة'
                });
            }

            console.log('✅ تم حذف نتيجة المباراة بنجاح');
            res.json({
                success: true,
                message: 'تم حذف نتيجة المباراة بنجاح'
            });
        }
    );
});

// 🆕 API لجلب رسائل شات البطولة
app.get('/api/tournament-chat/:gameId/messages', (req, res) => {
    const { gameId } = req.params;

    console.log('💬 جلب رسائل شات البطولة:', { gameId });

    db.all(
        `SELECT 
            id, game_id, user_id, username, message, is_admin, created_at
        FROM tournament_chat_messages
        WHERE game_id = ?
        ORDER BY created_at ASC`,
        [gameId],
        (err, rows) => {
            if (err) {
                console.error('❌ خطأ في جلب رسائل الشات:', err);
                return res.status(500).json({
                    success: false,
                    message: 'فشل جلب الرسائل'
                });
            }

            console.log(`✅ تم جلب ${rows.length} رسالة`);
            res.json({
                success: true,
                messages: rows
            });
        }
    );
});

// 🆕 API لإرسال رسالة في شات البطولة
app.post('/api/tournament-chat/:gameId/send', (req, res) => {
    const { gameId } = req.params;
    const { userId, username, message, isAdmin } = req.body;

    console.log('💬 إرسال رسالة في شات البطولة:', { gameId, userId, username, isAdmin });

    if (!userId || !username || !message?.trim()) {
        return res.status(400).json({
            success: false,
            message: 'يجب إدخال جميع البيانات'
        });
    }

    db.run(
        `INSERT INTO tournament_chat_messages (game_id, user_id, username, message, is_admin)
        VALUES (?, ?, ?, ?, ?)`,
        [gameId, userId, username, message.trim(), isAdmin ? 1 : 0],
        function(err) {
            if (err) {
                console.error('❌ خطأ في إرسال الرسالة:', err);
                return res.status(500).json({
                    success: false,
                    message: 'فشل إرسال الرسالة'
                });
            }

            const messageData = {
                id: this.lastID,
                game_id: parseInt(gameId),
                user_id: userId,
                username: username,
                message: message.trim(),
                is_admin: isAdmin ? 1 : 0,
                created_at: new Date().toISOString()
            };

            console.log('✅ تم إرسال الرسالة بنجاح');

            // إرسال الرسالة عبر Socket.io للمستخدمين الآخرين
            if (global.io) {
                global.io.to(`tournament-${gameId}`).emit('tournament-chat-message', messageData);
            }

            res.json({
                success: true,
                message: 'تم إرسال الرسالة',
                data: messageData
            });
        }
    );
});

// معالج الأخطاء العام (يجب أن يكون في النهاية بعد جميع routes)
app.use((err, req, res, next) => {
    console.error('❌ خطأ في الخادم:', err);
    res.status(500).json({ 
        success: false, 
        message: 'حدث خطأ في الخادم' 
    });
});

// معالج الأخطاء غير المعالجة
process.on('uncaughtException', (err) => {
    console.error('❌ خطأ غير معالج:', err);
    // لا نغلق العملية - نترك السيرفر يعمل
});

// معالج الأخطاء غير المعالجة في الوعود
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ رفع وعد غير معالج:', reason);
    // لا نغلق العملية - نترك السيرفر يعمل
});

// بدء الخادم مع معالج الأخطاء
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✓ الخادم يعمل على http://0.0.0.0:${PORT}`);
    console.log(`✓ يمكنك الدخول من أجهزة أخرى على الشبكة`);
    console.log(`✓ التطبيق جاهز للعمل`);
});

// 🆕 إعداد Socket.io للشات الجماعي في البطولات
const io = new Server(server, {
    cors: {
        origin: isProduction ? allowedOrigins : "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

// معالجة الاتصالات عبر Socket.io
io.on('connection', (socket) => {
    console.log('👤 مستخدم اتصل:', socket.id);

    // الانضمام إلى غرفة شات البطولة
    socket.on('join-tournament-chat', ({ gameId, userId }) => {
        const room = `tournament-${gameId}`;
        socket.join(room);
        
        // الحصول على عدد المستخدمين في الغرفة بعد الانضمام
        const roomSockets = io.sockets.adapter.rooms.get(room);
        const numClients = roomSockets ? roomSockets.size : 0;
        
        console.log(`💬 مستخدم ${userId} انضم إلى شات البطولة ${gameId}`)  ;
        console.log(`   - Socket ID: ${socket.id}`);
        console.log(`   - عدد المستخدمين في الغرفة الآن: ${numClients}`);
        
        // إرسال إشعار بالانضمام للآخرين
        socket.to(room).emit('user-joined', { userId, gameId });
    });

    // مغادرة غرفة شات البطولة
    socket.on('leave-tournament-chat', ({ gameId, userId }) => {
        const room = `tournament-${gameId}`;
        socket.leave(room);
        console.log(`💬 مستخدم ${userId} غادر شات البطولة ${gameId}`);
        
        // إرسال إشعار بالمغادرة للآخرين
        socket.to(room).emit('user-left', { userId, gameId });
    });

    // رسالة خروج المدير من غرفة الانتظار
    socket.on('admin-left-room', ({ gameId, adminId }) => {
        const room = `tournament-${gameId}`;
        console.log(`\n👑 ===== استقبال إشعار خروج المدير =====`);
        console.log(`   المدير ID: ${adminId}`);
        console.log(`   رقم المباراة: ${gameId}`);
        console.log(`   اسم الغرفة: ${room}`);
        
        // الحصول على عدد المستخدمين في الغرفة
        const roomSockets = io.sockets.adapter.rooms.get(room);
        const numClients = roomSockets ? roomSockets.size : 0;
        console.log(`   عدد المستخدمين في الغرفة: ${numClients}`);
        
        // بث الرسالة لجميع من في الغرفة
        io.to(room).emit('admin-left-room', { 
            gameId, 
            adminId,
            message: 'لقد غادر مدير البطولة التجمع. تم إنهاء الجلسة.'
        });
        
        console.log(`✅ تم بث إشعار admin-left-room للغرفة ${room}`);
        console.log(`==========================================\n`);
    });

    // قطع الاتصال
    socket.on('disconnect', () => {
        console.log('👤 مستخدم قطع الاتصال:', socket.id);
    });
});

// تصدير io لاستخدامه في بقية التطبيق
global.io = io;

// معالج أخطاء الخادم
server.on('error', (err) => {
    console.error('❌ خطأ في السيرفر:', err);
});

// إغلاق آمن عند طلب الإيقاف
process.on('SIGTERM', () => {
    console.log('تم استقبال إشارة SIGTERM - إيقاف آمن');
    server.close(() => {
        console.log('تم إيقاف السيرفر بنجاح');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('تم استقبال إشارة SIGINT - إيقاف آمن');
    server.close(() => {
        console.log('تم إيقاف السيرفر بنجاح');
        process.exit(0);
    });
});
