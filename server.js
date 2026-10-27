const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

const PROMO_FILE = path.join(DATA_DIR, 'promocodes.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DEPOSITS_FILE = path.join(DATA_DIR, 'deposits.json');
const WITHDRAWS_FILE = path.join(DATA_DIR, 'withdraws.json');

const ADMIN_USERNAMES = ['saintezz7', 'vortyn1'];

let promocodes = {};
let users = {};
let deposits = [];
let withdraws = [];

function ensureDataDir() {
    try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}
function loadJSON(file, fallback) {
    try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (err) { console.error('[ERROR] Load', file, err.message); }
    return fallback;
}
function saveJSON(file, data) {
    try { ensureDataDir(); fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8'); }
    catch (err) { console.error('[ERROR] Save', file, err.message); }
}

function loadAll() {
    promocodes = loadJSON(PROMO_FILE, {});
    users = loadJSON(USERS_FILE, {});
    deposits = loadJSON(DEPOSITS_FILE, []);
    withdraws = loadJSON(WITHDRAWS_FILE, []);
}
function savePromos() { saveJSON(PROMO_FILE, promocodes); }
function saveUsers() { saveJSON(USERS_FILE, users); }
function saveDeposits() { saveJSON(DEPOSITS_FILE, deposits); }
function saveWithdraws() { saveJSON(WITHDRAWS_FILE, withdraws); }

function setCORS(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function sendJSON(res, status, data) {
    setCORS(res);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try { resolve(body ? JSON.parse(body) : {}); }
            catch (err) { reject(new Error('Неверный JSON')); }
        });
        req.on('error', reject);
    });
}

function ensureUser(telegramId, username) {
    if (!telegramId) telegramId = 'guest_' + Date.now();
    if (!users[telegramId]) {
        users[telegramId] = {
            balance: 0, inventory: [], username: username || '',
            roblox_name: '', custom_nick: '', avatar: '', accent: '',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
    } else if (username && users[telegramId].username !== username) {
        users[telegramId].username = username;
        users[telegramId].updated_at = new Date().toISOString();
    }
    return users[telegramId];
}

function isAdmin(username) {
    return ADMIN_USERNAMES.includes((username || '').toLowerCase());
}

function computePendingWithdrawIds(telegramId) {
    const set = new Set();
    for (const w of withdraws) {
        if (w.status === 'pending' && String(w.telegram_id) === String(telegramId)) {
            set.add(w.item_id);
        }
    }
    return [...set];
}

const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') { setCORS(res); res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        setCORS(res);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Brainrot Game server is alive');
        return;
    }

    try {
        if (req.method === 'POST' && req.url === '/api/create') {
            const body = await readBody(req);
            const { code, uses, type, value, admin_username } = body;

            if (!isAdmin(admin_username)) {
                return sendJSON(res, 403, { ok: false, error: 'Нет доступа' });
            }

            if (!code || code.trim().length < 3) return sendJSON(res, 400, { ok: false, error: 'Название минимум 3 символа' });
            const upperCode = code.trim().toUpperCase();
            if (promocodes[upperCode]) return sendJSON(res, 409, { ok: false, error: 'Промокод уже есть' });

            promocodes[upperCode] = {
                code: upperCode, uses: parseInt(uses), type,
                value: type === 'percent' ? parseInt(value) : value,
                createdAt: new Date().toISOString()
            };
            savePromos();
            return sendJSON(res, 200, { ok: true, promo: promocodes[upperCode] });
        }

        if (req.method === 'POST' && req.url === '/api/activate') {
            const body = await readBody(req);
            const { code, telegram_id } = body;
            if (!code) return sendJSON(res, 400, { ok: false, error: 'Введите промокод' });

            const upperCode = code.trim().toUpperCase();
            const promo = promocodes[upperCode];
            if (!promo) return sendJSON(res, 404, { ok: false, error: 'Промокод не найден' });
            if (promo.uses <= 0) return sendJSON(res, 410, { ok: false, error: 'Промокод больше не активен' });

            promo.uses -= 1;
            savePromos();

            const u = ensureUser(telegram_id);
            if (promo.type === 'balance') {
                u.balance = (u.balance || 0) + promo.value;
            } else if (promo.type === 'item') {
                if (!Array.isArray(u.inventory)) u.inventory = [];
                u.inventory.push(promo.value);
            }
            u.updated_at = new Date().toISOString();
            saveUsers();

            return sendJSON(res, 200, { ok: true, type: promo.type, value: promo.value, remaining: promo.uses });
        }

        if (req.method === 'GET' && req.url === '/api/promocodes') {
            return sendJSON(res, 200, { ok: true, promocodes });
        }

        if (req.method === 'POST' && req.url === '/api/deposit/create') {
            const body = await readBody(req);
            const { telegram_id, username, item_id, item_name, item_price, base_price, roblox_name } = body;

            if (!telegram_id) return sendJSON(res, 400, { ok: false, error: 'telegram_id обязателен' });
            if (!item_id || !roblox_name) return sendJSON(res, 400, { ok: false, error: 'Не хватает данных' });

            const u = ensureUser(telegram_id, username);

            const deposit = {
                id: 'dep_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                telegram_id,
                username: username || u.username || '',
                item_id,
                item_name: item_name || '',
                item_price: parseInt(item_price) || 0,
                base_price: parseInt(base_price) || parseInt(item_price) || 0,
                roblox_name,
                status: 'pending',
                created_at: new Date().toISOString()
            };
            deposits.push(deposit);
            saveDeposits();

            return sendJSON(res, 200, { ok: true, deposit });
        }

        if (req.method === 'GET' && req.url.startsWith('/api/deposits')) {
            const url = new URL(req.url, 'http://localhost');
            const admin = url.searchParams.get('admin') || '';
            if (!isAdmin(admin)) {
                return sendJSON(res, 403, { ok: false, error: 'Нет доступа' });
            }
            return sendJSON(res, 200, { ok: true, deposits: deposits });
        }

        if (req.method === 'POST' && req.url === '/api/deposit/status') {
            const body = await readBody(req);
            const { id, status, admin } = body;

            if (!isAdmin(admin)) {
                return sendJSON(res, 403, { ok: false, error: 'Нет доступа' });
            }
            if (!id || !['accepted', 'rejected'].includes(status)) {
                return sendJSON(res, 400, { ok: false, error: 'Неверные данные' });
            }

            const dep = deposits.find(d => d.id === id);
            if (!dep) return sendJSON(res, 404, { ok: false, error: 'Заявка не найдена' });
            if (dep.status !== 'pending') return sendJSON(res, 409, { ok: false, error: 'Уже обработана' });

            dep.status = status;
            dep.processed_at = new Date().toISOString();
            dep.processed_by = admin || 'admin';

            if (status === 'accepted') {
                const u = ensureUser(dep.telegram_id, dep.username);
                u.balance = (u.balance || 0) + dep.item_price;
                saveUsers();
            }

            saveDeposits();
            return sendJSON(res, 200, { ok: true, deposit: dep });
        }

        if (req.method === 'POST' && req.url === '/api/withdraw/create') {
            const body = await readBody(req);
            const { telegram_id, username, item_id, item_name, item_price, roblox_name, time_slot, time_ts, comment } = body;

            if (!telegram_id || !item_id || !roblox_name || !time_slot) {
                return sendJSON(res, 400, { ok: false, error: 'Не хватает данных' });
            }

            const u = ensureUser(telegram_id, username);

            const invIndex = u.inventory.indexOf(item_id);
            if (invIndex === -1) {
                return sendJSON(res, 400, { ok: false, error: 'Предмет не найден в инвентаре' });
            }

            const alreadyPending = withdraws.some(w => w.status === 'pending' && String(w.telegram_id) === String(telegram_id) && w.item_id === item_id);
            if (alreadyPending) {
                return sendJSON(res, 409, { ok: false, error: 'Предмет уже на выводе' });
            }

            const withdraw = {
                id: 'wd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                telegram_id,
                username: username || u.username || '',
                item_id,
                item_name: item_name || '',
                item_price: parseInt(item_price) || 0,
                roblox_name,
                time_slot,
                time_ts: time_ts ? parseInt(time_ts) : null,
                comment: comment || '',
                status: 'pending',
                created_at: new Date().toISOString()
            };
            withdraws.push(withdraw);
            saveWithdraws();

            return sendJSON(res, 200, { ok: true, withdraw });
        }

        if (req.method === 'GET' && req.url.startsWith('/api/withdraws')) {
            const url = new URL(req.url, 'http://localhost');
            const admin = url.searchParams.get('admin') || '';
            if (!isAdmin(admin)) {
                return sendJSON(res, 403, { ok: false, error: 'Нет доступа' });
            }
            return sendJSON(res, 200, { ok: true, withdraws: withdraws });
        }

        if (req.method === 'POST' && req.url === '/api/withdraw/status') {
            const body = await readBody(req);
            const { id, status, admin } = body;

            if (!isAdmin(admin)) {
                return sendJSON(res, 403, { ok: false, error: 'Нет доступа' });
            }
            if (!id || !['accepted', 'rejected'].includes(status)) {
                return sendJSON(res, 400, { ok: false, error: 'Неверные данные' });
            }

            const wd = withdraws.find(w => w.id === id);
            if (!wd) return sendJSON(res, 404, { ok: false, error: 'Заявка не найдена' });
            if (wd.status !== 'pending') return sendJSON(res, 409, { ok: false, error: 'Уже обработана' });

            wd.status = status;
            wd.processed_at = new Date().toISOString();
            wd.processed_by = admin || 'admin';

            const u = ensureUser(wd.telegram_id, wd.username);

            if (status === 'accepted') {
                if (Array.isArray(u.inventory)) {
                    const i = u.inventory.indexOf(wd.item_id);
                    if (i !== -1) u.inventory.splice(i, 1);
                }
                u.updated_at = new Date().toISOString();
                saveUsers();
            }

            saveWithdraws();
            return sendJSON(res, 200, { ok: true, withdraw: wd });
        }

        if (req.method === 'GET' && req.url.startsWith('/api/user/')) {
            const id = decodeURIComponent(req.url.slice('/api/user/'.length));
            const u = ensureUser(id);
            saveUsers();
            const userOut = Object.assign({}, u, {
                pending_withdraw_ids: computePendingWithdrawIds(id)
            });
            return sendJSON(res, 200, { ok: true, user: userOut });
        }
        if (req.method === 'POST' && req.url === '/api/user/update') {
            const body = await readBody(req);
            const { telegram_id, balance, inventory, username, ...rest } = body;
            if (!telegram_id) return sendJSON(res, 400, { ok: false, error: 'telegram_id обязателен' });

            const u = ensureUser(telegram_id, username);
            if (typeof balance === 'number' && !isNaN(balance)) u.balance = balance;
            if (Array.isArray(inventory)) u.inventory = inventory;
            Object.assign(u, rest);
            u.updated_at = new Date().toISOString();
            saveUsers();
            return sendJSON(res, 200, { ok: true, user: u });
        }

        sendJSON(res, 404, { ok: false, error: 'Метод не найден' });
    } catch (err) {
        console.error(err);
        sendJSON(res, 500, { ok: false, error: 'Server Error' });
    }
});

loadAll();
server.listen(PORT, () => console.log('Brainrot Game server started on port ' + PORT));
