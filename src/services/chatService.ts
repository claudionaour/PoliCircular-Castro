import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  auth,
  db,
  handleFirestoreError,
  OperationType,
  toIsoString,
  toNullableIsoString,
} from './firebase';
import type { Conversation, MatchRecord, Message } from '../types/domain';

export type ConversationParticipantRole = 'participant_a' | 'participant_b';

function mapMessage(id: string, d: Record<string, unknown>): Message {
  return {
    id,
    conversation_id: String(d.conversation_id || ''),
    sender_id: String(d.sender_id || ''),
    body: String(d.body || ''),
    is_read: Boolean(d.is_read),
    read_at: toNullableIsoString(d.read_at),
    created_at: toIsoString(d.created_at),
  };
}

function mapConversation(
  id: string,
  d: Record<string, unknown>,
  fallbackMatchId = ''
): Conversation {
  return {
    id,
    match_id: String(d.match_id || fallbackMatchId),
    participant_a: String(d.participant_a || ''),
    participant_b: String(d.participant_b || ''),
    is_blocked: Boolean(d.is_blocked),
    blocked_by: d.blocked_by ? String(d.blocked_by) : null,
    created_at: toIsoString(d.created_at),
  };
}

async function resolveParticipantRole(
  conversationId: string,
  userId?: string,
  providedRole?: ConversationParticipantRole
): Promise<ConversationParticipantRole | undefined> {
  if (providedRole) return providedRole;
  if (!userId) return undefined;
  try {
    const convSnap = await getDoc(doc(db, 'conversations', conversationId));
    if (!convSnap.exists()) return undefined;
    const data = convSnap.data();
    if (String(data.participant_a || '') === userId) return 'participant_a';
    if (String(data.participant_b || '') === userId) return 'participant_b';
    return undefined;
  } catch {
    return undefined;
  }
}

export async function getConversationByMatch(matchId: string): Promise<Conversation | null> {
  const currentUid = auth.currentUser?.uid;
  try {
    const candidateIds = new Set<string>([`conv_${matchId}`]);
    if (matchId.startsWith('match_')) {
      candidateIds.add(`conv_${matchId.slice(6)}`);
    }

    for (const cid of candidateIds) {
      const directSnap = await getDoc(doc(db, 'conversations', cid)).catch(() => null);
      if (directSnap?.exists()) {
        const d = directSnap.data();
        if (String(d.match_id || '') === matchId) {
          return mapConversation(directSnap.id, d, matchId);
        }
      }
    }

    if (currentUid) {
      const [asA, asB] = await Promise.all([
        getDocs(query(collection(db, 'conversations'), where('participant_a', '==', currentUid))),
        getDocs(query(collection(db, 'conversations'), where('participant_b', '==', currentUid))),
      ]);
      const matchDoc =
        asA.docs.find((d) => String(d.data().match_id || '') === matchId) ??
        asB.docs.find((d) => String(d.data().match_id || '') === matchId);
      if (matchDoc) {
        return mapConversation(matchDoc.id, matchDoc.data(), matchId);
      }
      return null;
    }

    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'conversations');
  }
}

/**
 * Garantiza que exista una conversación autorizada para los participantes de un Match.
 * Si el Match existe pero no tiene documento de conversación (ej. registros antiguos),
 * lo crea y autoriza automáticamente para ambos participantes.
 */
export async function ensureConversationForMatch(
  match: MatchRecord,
  currentUserId: string
): Promise<Conversation> {
  const isParticipant =
    match.owner_id === currentUserId || match.requester_id === currentUserId;
  if (!isParticipant) {
    throw new Error('No perteneces a este Match para acceder al chat privado.');
  }

  const candidateIds = Array.from(
    new Set(
      [
        match.request_id ? `conv_${match.request_id}` : '',
        `conv_${match.id}`,
      ].filter(Boolean)
    )
  );

  for (const cid of candidateIds) {
    const directSnap = await getDoc(doc(db, 'conversations', cid)).catch(() => null);
    if (directSnap?.exists()) {
      const d = directSnap.data();
      if (String(d.match_id || '') === match.id) {
        return mapConversation(directSnap.id, d, match.id);
      }
    }
  }

  try {
    const [asA, asB] = await Promise.all([
      getDocs(
        query(collection(db, 'conversations'), where('participant_a', '==', currentUserId))
      ).catch(() => null),
      getDocs(
        query(collection(db, 'conversations'), where('participant_b', '==', currentUserId))
      ).catch(() => null),
    ]);

    const existingDoc =
      asA?.docs.find((d) => String(d.data().match_id || '') === match.id) ??
      asB?.docs.find((d) => String(d.data().match_id || '') === match.id);
    if (existingDoc) {
      return mapConversation(existingDoc.id, existingDoc.data(), match.id);
    }

    const convId = match.request_id ? `conv_${match.request_id}` : `conv_${match.id}`;
    await setDoc(doc(db, 'conversations', convId), {
      id: convId,
      match_id: match.id,
      participant_a: match.owner_id,
      participant_b: match.requester_id,
      is_blocked: false,
      blocked_by: null,
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });

    return {
      id: convId,
      match_id: match.id,
      participant_a: match.owner_id,
      participant_b: match.requester_id,
      is_blocked: false,
      blocked_by: null,
      created_at: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `conversations/conv_${match.id}`);
  }
}

export async function listMessages(
  conversationId: string,
  currentUserId?: string,
  participantRole?: ConversationParticipantRole
): Promise<Message[]> {
  try {
    const uid = currentUserId || auth.currentUser?.uid;
    const role = await resolveParticipantRole(conversationId, uid, participantRole);

    const snap =
      uid && role
        ? await getDocs(query(collection(db, 'messages'), where(role, '==', uid)))
        : await getDocs(
            query(collection(db, 'messages'), where('conversation_id', '==', conversationId))
          );

    return snap.docs
      .filter((d) => String(d.data().conversation_id || '') === conversationId)
      .map((d) => mapMessage(d.id, d.data()))
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'messages');
  }
}

export async function sendMessage(
  conversationId: string,
  senderId: string,
  body: string
): Promise<Message> {
  const convSnap = await getDoc(doc(db, 'conversations', conversationId));
  if (!convSnap.exists()) {
    throw new Error('No se encontró la conversación del match.');
  }
  const conv = convSnap.data();
  if (conv.is_blocked) {
    throw new Error('Esta conversación está bloqueada.');
  }

  const msgRef = doc(collection(db, 'messages'));
  const cleanBody = body.trim();

  try {
    await setDoc(msgRef, {
      id: msgRef.id,
      conversation_id: conversationId,
      participant_a: String(conv.participant_a),
      participant_b: String(conv.participant_b),
      sender_id: senderId,
      body: cleanBody,
      is_read: false,
      created_at: serverTimestamp(),
    });

    return {
      id: msgRef.id,
      conversation_id: conversationId,
      sender_id: senderId,
      body: cleanBody,
      is_read: false,
      read_at: null,
      created_at: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `messages/${msgRef.id}`);
  }
}

export async function markConversationMessagesRead(
  conversationId: string,
  currentUserId: string,
  participantRole?: ConversationParticipantRole
): Promise<void> {
  try {
    const role = await resolveParticipantRole(conversationId, currentUserId, participantRole);
    const snap = role
      ? await getDocs(query(collection(db, 'messages'), where(role, '==', currentUserId)))
      : await getDocs(
          query(collection(db, 'messages'), where('conversation_id', '==', conversationId))
        );

    const unreadFromOther = snap.docs.filter(
      (d) =>
        String(d.data().conversation_id || '') === conversationId &&
        !d.data().is_read &&
        d.data().sender_id !== currentUserId
    );
    if (unreadFromOther.length === 0) return;

    const batch = writeBatch(db);
    unreadFromOther.forEach((d) => {
      batch.update(d.ref, {
        is_read: true,
        read_at: serverTimestamp(),
      });
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, 'messages');
  }
}

export async function toggleConversationBlock(
  conversationId: string,
  userId: string,
  block: boolean
): Promise<void> {
  try {
    await updateDoc(doc(db, 'conversations', conversationId), {
      is_blocked: block,
      blocked_by: block ? userId : null,
      updated_at: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `conversations/${conversationId}`);
  }
}

export function subscribeToConversationMessages(
  conversationId: string,
  onInsert: (msg: Message) => void,
  onUpdate: (msg: Message) => void,
  options?: { userId?: string; participantRole?: ConversationParticipantRole }
): { unsubscribe: () => void } {
  const q =
    options?.userId && options?.participantRole
      ? query(collection(db, 'messages'), where(options.participantRole, '==', options.userId))
      : query(collection(db, 'messages'), where('conversation_id', '==', conversationId));

  const unsub = onSnapshot(
    q,
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const raw = change.doc.data();
        if (String(raw.conversation_id || '') !== conversationId) return;
        const msg = mapMessage(change.doc.id, raw);
        if (change.type === 'added') onInsert(msg);
        if (change.type === 'modified') onUpdate(msg);
      });
    },
    (error) => {
      console.error('Error en suscripción de chat Firestore:', error);
    }
  );

  return { unsubscribe: unsub };
}
