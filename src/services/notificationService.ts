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
import { db, handleFirestoreError, OperationType, toIsoString, toNullableIsoString } from './firebase';
import { MODALITY_LABELS } from '../utils/formatters';
import type {
  AppNotification,
  Product,
  ProductAlertSubscription,
  ProductModality,
} from '../types/domain';

function mapNotification(id: string, d: Record<string, unknown>): AppNotification {
  return {
    id,
    user_id: String(d.user_id || ''),
    event_type: String(d.event_type || ''),
    title: String(d.title || ''),
    body: String(d.body || ''),
    link_path: d.link_path ? String(d.link_path) : null,
    is_read: Boolean(d.is_read),
    read_at: toNullableIsoString(d.read_at),
    created_at: toIsoString(d.created_at),
  };
}

function mapAlertSubscription(userId: string, d: Record<string, unknown>): ProductAlertSubscription {
  return {
    user_id: String(d.user_id || userId),
    enabled: Boolean(d.enabled),
    category_ids: Array.isArray(d.category_ids)
      ? d.category_ids.map((x) => String(x)).filter(Boolean).slice(0, 20)
      : [],
    commune_id: d.commune_id ? String(d.commune_id) : null,
    modality:
      d.modality === 'gift' || d.modality === 'exchange' ? d.modality : 'all',
    keywords: Array.isArray(d.keywords)
      ? d.keywords.map((x) => String(x)).filter(Boolean).slice(0, 10)
      : [],
    browser_notifications: Boolean(d.browser_notifications),
    updated_at: toIsoString(d.updated_at),
  };
}

function normalizeMatchText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export async function listNotifications(userId: string): Promise<AppNotification[]> {
  try {
    const snap = await getDocs(
      query(collection(db, 'notifications'), where('user_id', '==', userId))
    );
    return snap.docs
      .map((d) => mapNotification(d.id, d.data()))
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, 60);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'notifications');
  }
}

export async function markNotificationRead(notificationId: string): Promise<void> {
  try {
    await updateDoc(doc(db, 'notifications', notificationId), {
      is_read: true,
      read_at: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `notifications/${notificationId}`);
  }
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  try {
    const snap = await getDocs(
      query(collection(db, 'notifications'), where('user_id', '==', userId))
    );
    const unreadDocs = snap.docs.filter((d) => !d.data().is_read);
    if (unreadDocs.length === 0) return;
    const batch = writeBatch(db);
    unreadDocs.forEach((d) => {
      batch.update(d.ref, {
        is_read: true,
        read_at: serverTimestamp(),
      });
    });
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, 'notifications');
  }
}

export function subscribeUserNotifications(
  userId: string,
  onNewNotification: (notif: AppNotification, isRealtime: boolean) => void
): { unsubscribe: () => void } {
  const q = query(collection(db, 'notifications'), where('user_id', '==', userId));
  let initialSnapshot = true;

  const unsub = onSnapshot(
    q,
    (snapshot) => {
      const isRealtime = !initialSnapshot;
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          onNewNotification(mapNotification(change.doc.id, change.doc.data()), isRealtime);
        }
      });
      initialSnapshot = false;
    },
    (error) => {
      console.error('Error en notificaciones Firestore:', error);
    }
  );

  return { unsubscribe: unsub };
}

export async function getProductAlertSubscription(
  userId: string
): Promise<ProductAlertSubscription | null> {
  try {
    const snap = await getDoc(doc(db, 'product_alert_subscriptions', userId));
    if (!snap.exists()) return null;
    return mapAlertSubscription(userId, snap.data());
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `product_alert_subscriptions/${userId}`);
  }
}

export interface SaveProductAlertInput {
  enabled: boolean;
  categoryIds: string[];
  communeId: string | null;
  modality: 'all' | ProductModality;
  keywords: string[];
  browserNotifications: boolean;
}

export async function saveProductAlertSubscription(
  userId: string,
  input: SaveProductAlertInput
): Promise<ProductAlertSubscription> {
  const cleanCategories = Array.from(new Set(input.categoryIds.map((c) => c.trim()).filter(Boolean)))
    .map((c) => c.slice(0, 128))
    .slice(0, 20);
  const cleanKeywords = Array.from(new Set(input.keywords.map((k) => k.trim()).filter(Boolean)))
    .map((k) => k.slice(0, 50))
    .slice(0, 10);

  const payload = {
    user_id: userId,
    enabled: input.enabled,
    category_ids: cleanCategories,
    commune_id: input.communeId ? input.communeId.trim().slice(0, 128) : null,
    modality: input.modality,
    keywords: cleanKeywords,
    browser_notifications: input.browserNotifications,
    updated_at: serverTimestamp(),
  };

  try {
    await setDoc(doc(db, 'product_alert_subscriptions', userId), payload);
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `product_alert_subscriptions/${userId}`);
  }

  return {
    user_id: userId,
    enabled: payload.enabled,
    category_ids: cleanCategories,
    commune_id: payload.commune_id,
    modality: payload.modality,
    keywords: cleanKeywords,
    browser_notifications: payload.browser_notifications,
    updated_at: new Date().toISOString(),
  };
}

export async function notifyInterestedUsersForNewProduct(product: Product): Promise<number> {
  try {
    const snap = await getDocs(
      query(collection(db, 'product_alert_subscriptions'), where('enabled', '==', true))
    );
    if (snap.empty) return 0;

    const searchableText = normalizeMatchText(
      `${product.title} ${product.description} ${product.categories?.name || ''} ${product.communes?.name || ''} ${product.sectors?.name || ''}`
    );

    const matchingUserIds: string[] = [];
    snap.forEach((docSnap) => {
      const sub = mapAlertSubscription(docSnap.id, docSnap.data());
      if (!sub.enabled) return;
      if (sub.user_id === product.owner_id) return;
      if (sub.category_ids.length > 0 && !sub.category_ids.includes(product.category_id)) return;
      if (sub.commune_id && sub.commune_id !== product.commune_id) return;
      if (sub.modality !== 'all' && sub.modality !== product.modality) return;
      if (sub.keywords.length > 0) {
        const matchesKeyword = sub.keywords.some((kw) =>
          searchableText.includes(normalizeMatchText(kw))
        );
        if (!matchesKeyword) return;
      }
      matchingUserIds.push(sub.user_id);
    });

    const uniqueRecipients = Array.from(new Set(matchingUserIds));
    if (uniqueRecipients.length === 0) return 0;

    const modalityLabel = MODALITY_LABELS[product.modality];
    const categoryName = product.categories?.name || 'Economía circular';
    const communeName = product.communes?.name || 'tu comunidad';
    const title = `Nuevo producto: ${product.title}`.slice(0, 140);
    const body = `${modalityLabel} · ${categoryName} en ${communeName}. ¡Revísalo en el catálogo antes de que se reserve!`.slice(
      0,
      500
    );
    const linkPath = `/producto/${product.id}`.slice(0, 200);

    for (let i = 0; i < uniqueRecipients.length; i += 400) {
      const chunk = uniqueRecipients.slice(i, i + 400);
      const batch = writeBatch(db);
      for (const recipientId of chunk) {
        const notifRef = doc(collection(db, 'notifications'));
        batch.set(notifRef, {
          id: notifRef.id,
          user_id: recipientId,
          event_type: 'new_product_alert',
          title,
          body,
          link_path: linkPath,
          is_read: false,
          created_at: serverTimestamp(),
        });
      }
      await batch.commit();
    }

    return uniqueRecipients.length;
  } catch (err) {
    console.warn('No se pudieron enviar alertas a usuarios interesados:', err);
    return 0;
  }
}
