// ─────────────────────────────────────────────────────────────────────────────
// Заметки администраторов о клиентах — чистая логика (без БД), покрыта тестами.
// ─────────────────────────────────────────────────────────────────────────────

export const NOTE_MAX_LEN = 1000;

// Роли, которым доступны заметки. Курьеры заметки не видят.
export const NOTE_ROLES = ["owner", "admin"];

export function canUseNotes(role) {
    return NOTE_ROLES.includes(role);
}

// Удалять и менять текст может автор заметки или владелец.
export function canManageNote(user, note) {
    if (!user || !note) return false;
    if (user.role === "owner") return true;
    return note.created_by != null && Number(note.created_by) === Number(user.userId);
}

// Телефон в формате +371XXXXXXXX (8–15 цифр после плюса).
export function isValidNotePhone(phone) {
    return /^\+\d{8,15}$/.test(String(phone || ""));
}

// → { ok:true, text } | { ok:false, error }
export function validateNoteText(raw) {
    const text = String(raw ?? "").replace(/\r\n/g, "\n").trim();
    if (!text) return { ok: false, error: "Введите текст заметки" };
    if (text.length > NOTE_MAX_LEN) {
        return { ok: false, error: `Заметка слишком длинная (максимум ${NOTE_MAX_LEN} символов)` };
    }
    return { ok: true, text };
}

const toIso = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// Строка БД → объект для клиента.
export function rowToNoteDto(row, user) {
    return {
        id: Number(row.id),
        text: row.note_text,
        authorName: row.created_by_name || "",
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        done: !!row.done_at,
        doneAt: toIso(row.done_at),
        doneByName: row.done_by_name || null,
        canManage: canManageNote(user, row),
    };
}
