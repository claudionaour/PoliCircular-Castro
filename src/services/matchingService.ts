import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import {
  ENABLE_CLOUD_FUNCTIONS,
  auth,
  db,
  functions,
  handleFirestoreError,
  OperationType,
  toIsoString,
  toNullableIsoString,
} from './firebase';
import {
  fetchImagesByProductIds,
  fetchLookupMaps,
  fetchProfilesMap,
  hydrateProductDoc,
} from './firestoreHelpers';
import { SEED_CATEGORIES } from './seedService';
import { computeTreeStage } from '../utils/formatters';
import type {
  Conversation,
  ExchangeConfirmation,
  ExchangeRecord,
  InterestDecision,
  MatchRecord,
  MatchRequest,
  Product,
  ProductModality,
} from '../types/domain';

export async function upsertProductInterest(
  productId: string,
  userId: string,
  decision: InterestDecision
): Promise<void> {
  const docId = `${userId}_${productId}`;
  try {
    await setDoc(doc(db, 'product_interests', docId), {
      id: docId,
      product_id: productId,
      user_id: userId,
      decision,
      updated_at: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `product_interests/${docId}`);
  }
}

export async function listUserInterests(userId: string) {
  try {
    const snap = await getDocs(
      query(collection(db, 'product_interests'), where('user_id', '==', userId))
    );
    if (snap.empty) return [];

    const maps = await fetchLookupMaps();
    const productIds = snap.docs.map((d) => String(d.data().product_id || ''));
    const productSnaps = await Promise.all(
      Array.from(new Set(productIds)).map((pid) =>
        getDoc(doc(db, 'products', pid)).catch(() => null)
      )
    );
    const images = await fetchImagesByProductIds(productIds);
    const ownerIds = productSnaps
      .filter((s): s is NonNullable<typeof s> => Boolean(s?.exists()))
      .map((s) => String(s.data()!.owner_id || ''));
    const profiles = await fetchProfilesMap(ownerIds);

    const productMap = new Map<string, Product>();
    productSnaps.forEach((pSnap) => {
      if (pSnap?.exists()) {
        productMap.set(
          pSnap.id,
          hydrateProductDoc(pSnap.id, pSnap.data(), { ...maps, profiles, images })
        );
      }
    });

    return snap.docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          product_id: String(data.product_id || ''),
          user_id: String(data.user_id || ''),
          decision: data.decision as InterestDecision,
          updated_at: toIsoString(data.updated_at),
          products: productMap.get(String(data.product_id || '')) ?? null,
        };
      })
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'product_interests');
  }
}

export async function createMatchRequest(params: {
  targetProductId: string;
  requesterId: string;
  ownerId: string;
  modality: ProductModality;
  offeredProductId?: string | null;
  requestedQuantity: number;
  message?: string;
}): Promise<MatchRequest> {
  if (params.requesterId === params.ownerId) {
    throw new Error('No puedes enviar una solicitud sobre tu propia publicación.');
  }
  if (!Number.isInteger(params.requestedQuantity) || params.requestedQuantity < 1) {
    throw new Error('La cantidad solicitada debe ser al menos 1.');
  }

  // Evitar solicitudes duplicadas activas sobre el mismo producto
  try {
    const myReqsSnap = await getDocs(
      query(collection(db, 'match_requests'), where('requester_id', '==', params.requesterId))
    );
    const hasPending = myReqsSnap.docs.some((d) => {
      const data = d.data();
      return (
        String(data.target_product_id) === params.targetProductId &&
        ['pending', 'chat_requested'].includes(String(data.status))
      );
    });
    if (hasPending) {
      throw new Error(
        'Ya tienes una solicitud pendiente para este producto. Puedes revisarla en Mis Match.'
      );
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('solicitud pendiente')) {
      throw err;
    }
  }

  const reqRef = doc(collection(db, 'match_requests'));
  const notifRef = doc(collection(db, 'notifications'));

  try {
    const batch = writeBatch(db);
    batch.set(reqRef, {
      id: reqRef.id,
      target_product_id: params.targetProductId,
      requester_id: params.requesterId,
      owner_id: params.ownerId,
      modality: params.modality,
      offered_product_id:
        params.modality === 'exchange' ? params.offeredProductId || null : null,
      requested_quantity: params.requestedQuantity,
      message: params.message?.trim() || null,
      status: 'pending',
      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
    });

    batch.set(notifRef, {
      id: notifRef.id,
      user_id: params.ownerId,
      event_type: 'match_request_received',
      title: 'Nueva solicitud circular',
      body:
        params.modality === 'gift'
          ? 'Un vecino solicitó uno de tus regalos publicados.'
          : 'Un vecino propuso un intercambio por tu publicación.',
      link_path: '/matches',
      is_read: false,
      created_at: serverTimestamp(),
    });

    await batch.commit();

    return {
      id: reqRef.id,
      target_product_id: params.targetProductId,
      requester_id: params.requesterId,
      owner_id: params.ownerId,
      modality: params.modality,
      offered_product_id:
        params.modality === 'exchange' ? params.offeredProductId || null : null,
      requested_quantity: params.requestedQuantity,
      message: params.message?.trim() || null,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `match_requests/${reqRef.id}`);
  }
}

export async function listMatchRequests(userId: string): Promise<MatchRequest[]> {
  try {
    const [asOwnerSnap, asRequesterSnap] = await Promise.all([
      getDocs(query(collection(db, 'match_requests'), where('owner_id', '==', userId))),
      getDocs(query(collection(db, 'match_requests'), where('requester_id', '==', userId))),
    ]);

    const docMap = new Map<string, (typeof asOwnerSnap.docs)[number]>();
    asOwnerSnap.docs.forEach((d) => docMap.set(d.id, d));
    asRequesterSnap.docs.forEach((d) => docMap.set(d.id, d));
    if (docMap.size === 0) return [];

    const docs = Array.from(docMap.values());
    const productIds: string[] = [];
    const userIds: string[] = [];
    docs.forEach((d) => {
      const data = d.data();
      if (data.target_product_id) productIds.push(String(data.target_product_id));
      if (data.offered_product_id) productIds.push(String(data.offered_product_id));
      if (data.requester_id) userIds.push(String(data.requester_id));
      if (data.owner_id) userIds.push(String(data.owner_id));
    });

    const [maps, profiles, images, productSnaps] = await Promise.all([
      fetchLookupMaps(),
      fetchProfilesMap(userIds),
      fetchImagesByProductIds(productIds),
      Promise.all(
        Array.from(new Set(productIds)).map((pid) =>
          getDoc(doc(db, 'products', pid)).catch(() => null)
        )
      ),
    ]);

    const productMap = new Map<string, Product>();
    productSnaps.forEach((pSnap) => {
      if (pSnap?.exists()) {
        productMap.set(
          pSnap.id,
          hydrateProductDoc(pSnap.id, pSnap.data(), { ...maps, profiles, images })
        );
      }
    });

    return docs
      .map((d) => {
        const data = d.data();
        return {
          id: d.id,
          target_product_id: String(data.target_product_id || ''),
          requester_id: String(data.requester_id || ''),
          owner_id: String(data.owner_id || ''),
          modality: data.modality as ProductModality,
          offered_product_id: data.offered_product_id ? String(data.offered_product_id) : null,
          requested_quantity: Number(data.requested_quantity ?? 1),
          message: data.message ? String(data.message) : null,
          status: data.status,
          created_at: toIsoString(data.created_at),
          target_product: productMap.get(String(data.target_product_id || '')) ?? null,
          offered_product: data.offered_product_id
            ? productMap.get(String(data.offered_product_id)) ?? null
            : null,
          requester: profiles.get(String(data.requester_id || '')) ?? null,
          owner: profiles.get(String(data.owner_id || '')) ?? null,
        } satisfies MatchRequest;
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'match_requests');
  }
}

export async function acceptMatchRequestRpc(requestId: string): Promise<string> {
  if (ENABLE_CLOUD_FUNCTIONS) {
    const fn = httpsCallable<{ requestId: string }, { matchId: string }>(
      functions,
      'acceptMatchRequest'
    );
    const res = await fn({ requestId });
    return res.data.matchId;
  }

  const currentUid = auth.currentUser?.uid;
  if (!currentUid) throw new Error('Debes iniciar sesión.');

  // IDs determinísticos para garantizar idempotencia ante reintentos o dobles clics
  const reqRef = doc(db, 'match_requests', requestId);
  const matchId = `match_${requestId}`;
  const convId = `conv_${requestId}`;
  const exchangeId = `ex_${requestId}`;
  const notifReqId = `notif_req_${requestId}`;
  const notifOwnerId = `notif_own_${requestId}`;

  const achievementsSnap = await getDocs(
    query(collection(db, 'achievements'), where('required_operations', '>=', 1))
  ).catch(() => null);

  try {
    const txResult = await runTransaction(db, async (tx) => {
      // 1. TODAS LAS LECTURAS ANTES DE CUALQUIER ESCRITURA
      const reqSnap = await tx.get(reqRef);
      if (!reqSnap.exists()) throw new Error('Solicitud no encontrada.');
      const reqData = reqSnap.data();

      const ownerId = String(reqData.owner_id);
      const requesterId = String(reqData.requester_id);

      if (ownerId !== currentUid) {
        throw new Error('Solo quien publicó el producto puede aceptar la solicitud.');
      }

      const matchRef = doc(db, 'matches', matchId);
      const convRef = doc(db, 'conversations', convId);
      const exchangeRef = doc(db, 'exchanges', exchangeId);
      const ownerConfId = `${exchangeId}_${ownerId}`;
      const requesterConfId = `${exchangeId}_${requesterId}`;
      const ownerConfRef = doc(db, 'exchange_confirmations', ownerConfId);
      const requesterConfRef = doc(db, 'exchange_confirmations', requesterConfId);
      const impactRef = doc(db, 'impact_records', exchangeId);
      const notifReqRef = doc(db, 'notifications', notifReqId);
      const notifOwnRef = doc(db, 'notifications', notifOwnerId);
      const ownerTreeRef = doc(db, 'user_tree_progress', ownerId);
      const requesterTreeRef = doc(db, 'user_tree_progress', requesterId);
      const productRef = doc(db, 'products', String(reqData.target_product_id));

      const [
        existingMatchSnap,
        existingConvSnap,
        existingExSnap,
        existingOwnerConfSnap,
        existingReqConfSnap,
        existingImpactSnap,
        existingNotifReqSnap,
        existingNotifOwnSnap,
        productSnap,
        ownerTreeSnap,
        requesterTreeSnap,
      ] = await Promise.all([
        tx.get(matchRef),
        tx.get(convRef),
        tx.get(exchangeRef),
        tx.get(ownerConfRef),
        tx.get(requesterConfRef),
        tx.get(impactRef),
        tx.get(notifReqRef),
        tx.get(notifOwnRef),
        tx.get(productRef),
        tx.get(ownerTreeRef),
        tx.get(requesterTreeRef),
      ]);

      // Guard de idempotencia: si el Match completo ya fue aplicado en un intento previo, retornar directamente
      if (
        reqData.status === 'accepted' &&
        existingMatchSnap.exists() &&
        existingExSnap.exists() &&
        existingImpactSnap.exists()
      ) {
        return { matchId, participantUpdates: [] as { uid: string; nextOps: number }[] };
      }

      if (!['pending', 'chat_requested'].includes(reqData.status)) {
        throw new Error('La solicitud ya fue procesada.');
      }

      if (!productSnap.exists()) throw new Error('Publicación no encontrada.');
      const prod = productSnap.data();

      const catSnap = await tx.get(doc(db, 'categories', String(prod.category_id)));
      const fallbackCatWeight =
        SEED_CATEGORIES.find((c) => c.id === String(prod.category_id))?.estimated_weight_kg ?? 1;
      const catWeight = catSnap.exists()
        ? Number(catSnap.data().estimated_weight_kg ?? fallbackCatWeight)
        : fallbackCatWeight;

      const qty = Number(reqData.requested_quantity ?? 1);
      const available = Number(prod.available_quantity ?? 0);
      if (prod.status !== 'approved' || available < qty) {
        throw new Error('No queda suficiente cantidad disponible para completar este Match.');
      }

      const nextAvailable = available - qty;
      const currentReserved = Number(prod.reserved_quantity ?? 0);
      const nextProdStatus =
        nextAvailable === 0 && currentReserved === 0 ? 'completed' : 'approved';

      const isGift = reqData.modality === 'gift';

      const buildTreeUpdate = (
        uid: string,
        snap: typeof ownerTreeSnap
      ) => {
        const prev = snap.exists()
          ? snap.data()
          : { completed_operations: 0, completed_gifts: 0, completed_exchanges: 0, last_exchange_id: '' };
        const alreadyApplied = String(prev.last_exchange_id || '') === exchangeId;
        const prevOps = Number(prev.completed_operations ?? 0);
        const nextOps = alreadyApplied ? prevOps : prevOps + 1;
        return {
          uid,
          alreadyApplied,
          nextOps,
          nextGifts: Number(prev.completed_gifts ?? 0) + (alreadyApplied ? 0 : isGift ? 1 : 0),
          nextEx: Number(prev.completed_exchanges ?? 0) + (alreadyApplied ? 0 : isGift ? 0 : 1),
        };
      };

      const ownerProgress = buildTreeUpdate(ownerId, ownerTreeSnap);
      const requesterProgress = buildTreeUpdate(requesterId, requesterTreeSnap);
      const participantUpdates = [ownerProgress, requesterProgress];

      // 2. ESCRITURAS ATÓMICAS: MATCH + CONFIRMACIÓN AUTOMÁTICA + ESTADÍSTICAS
      tx.update(reqRef, {
        status: 'accepted',
        updated_at: serverTimestamp(),
      });

      tx.update(productRef, {
        available_quantity: nextAvailable,
        reserved_quantity: currentReserved,
        status: nextProdStatus,
        sync_exchange_id: exchangeId,
        updated_at: serverTimestamp(),
      });

      if (!existingMatchSnap.exists()) {
        tx.set(matchRef, {
          id: matchId,
          request_id: requestId,
          target_product_id: reqData.target_product_id,
          offered_product_id: reqData.offered_product_id || null,
          owner_id: ownerId,
          requester_id: requesterId,
          modality: reqData.modality,
          quantity_reserved: qty,
          status: 'completed',
          created_at: serverTimestamp(),
          updated_at: serverTimestamp(),
        });
      }

      if (!existingConvSnap.exists()) {
        tx.set(convRef, {
          id: convId,
          match_id: matchId,
          participant_a: ownerId,
          participant_b: requesterId,
          is_blocked: false,
          blocked_by: null,
          created_at: serverTimestamp(),
          updated_at: serverTimestamp(),
        });
      }

      if (!existingExSnap.exists()) {
        tx.set(exchangeRef, {
          id: exchangeId,
          match_id: matchId,
          owner_id: ownerId,
          requester_id: requesterId,
          status: 'completed',
          completed_at: serverTimestamp(),
          created_at: serverTimestamp(),
          updated_at: serverTimestamp(),
        });
      }

      if (!existingOwnerConfSnap.exists()) {
        tx.set(ownerConfRef, {
          id: ownerConfId,
          exchange_id: exchangeId,
          user_id: ownerId,
          owner_id: ownerId,
          requester_id: requesterId,
          confirmed_at: serverTimestamp(),
          notes: 'Confirmación automática al realizar Match',
          measured_weight_kg: null,
        });
      }

      if (!existingReqConfSnap.exists()) {
        tx.set(requesterConfRef, {
          id: requesterConfId,
          exchange_id: exchangeId,
          user_id: requesterId,
          owner_id: ownerId,
          requester_id: requesterId,
          confirmed_at: serverTimestamp(),
          notes: 'Confirmación automática al realizar Match',
          measured_weight_kg: null,
        });
      }

      for (const p of participantUpdates) {
        if (!p.alreadyApplied) {
          tx.set(doc(db, 'user_tree_progress', p.uid), {
            user_id: p.uid,
            completed_operations: p.nextOps,
            completed_gifts: p.nextGifts,
            completed_exchanges: p.nextEx,
            current_stage: computeTreeStage(p.nextOps),
            last_exchange_id: exchangeId,
            updated_at: serverTimestamp(),
          });
        }
      }

      if (!existingImpactSnap.exists()) {
        const estimatedWeight = Number((catWeight * qty).toFixed(2));
        tx.set(impactRef, {
          id: exchangeId,
          exchange_id: exchangeId,
          product_id: String(prod.id),
          category_id: String(prod.category_id),
          commune_id: String(prod.commune_id),
          sector_id: prod.sector_id ? String(prod.sector_id) : null,
          modality: reqData.modality,
          quantity: qty,
          weight_kg: estimatedWeight,
          weight_type: 'estimated',
          created_at: serverTimestamp(),
        });
      }

      const safeTitle = String(prod.title || 'Producto').slice(0, 80);

      if (!existingNotifReqSnap.exists()) {
        tx.set(notifReqRef, {
          id: notifReqId,
          user_id: requesterId,
          event_type: 'match_accepted',
          title: '¡Match confirmado automáticamente!',
          body: `Aceptaron tu solicitud por “${safeTitle}”. La entrega se confirmó y sumó a tu Árbol Circular; ya pueden coordinar el retiro por chat.`,
          link_path: `/matches/${matchId}`,
          is_read: false,
          created_at: serverTimestamp(),
        });
      }

      if (!existingNotifOwnSnap.exists()) {
        tx.set(notifOwnRef, {
          id: notifOwnerId,
          user_id: ownerId,
          event_type: 'match_completed_stats',
          title: 'Match registrado en tus estadísticas',
          body: `“${safeTitle}” se confirmó automáticamente y sumó +1 operación a tu Árbol Circular e Impacto Ambiental.`,
          link_path: '/mi-arbol',
          is_read: false,
          created_at: serverTimestamp(),
        });
      }

      return {
        matchId,
        participantUpdates: participantUpdates.map((p) => ({ uid: p.uid, nextOps: p.nextOps })),
      };
    });

    // Desbloqueo idempotente de insignias sin sobrecargar el límite de lecturas de la transacción principal
    if (achievementsSnap && !achievementsSnap.empty && txResult.participantUpdates.length > 0) {
      const candidates: { recId: string; uid: string; achId: string }[] = [];
      for (const p of txResult.participantUpdates) {
        for (const achDoc of achievementsSnap.docs) {
          const reqOps = Number(achDoc.data().required_operations ?? 1);
          if (p.nextOps >= reqOps) {
            candidates.push({
              recId: `${p.uid}_${achDoc.id}`,
              uid: p.uid,
              achId: achDoc.id,
            });
          }
        }
      }

      if (candidates.length > 0) {
        const existingChecks = await Promise.all(
          candidates.map((c) => getDoc(doc(db, 'user_achievements', c.recId)).catch(() => null))
        );
        const batch = writeBatch(db);
        let hasNew = false;
        candidates.forEach((c, idx) => {
          if (existingChecks[idx] && !existingChecks[idx]!.exists()) {
            hasNew = true;
            batch.set(doc(db, 'user_achievements', c.recId), {
              id: c.recId,
              user_id: c.uid,
              achievement_id: c.achId,
              exchange_id: exchangeId,
              unlocked_at: serverTimestamp(),
            });
          }
        });
        if (hasNew) {
          await batch.commit().catch((err) => {
            console.warn('No se pudieron registrar insignias secundarias:', err);
          });
        }
      }
    }

    return txResult.matchId;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `match_requests/${requestId}`);
  }
}

export async function updateMatchRequestStatus(
  requestId: string,
  status: 'rejected' | 'cancelled' | 'chat_requested'
): Promise<void> {
  try {
    await updateDoc(doc(db, 'match_requests', requestId), {
      status,
      updated_at: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `match_requests/${requestId}`);
  }
}

async function hydrateMatchDocs(
  matchDocs: { id: string; data: () => Record<string, unknown> }[]
): Promise<MatchRecord[]> {
  if (matchDocs.length === 0) return [];

  const currentUid = auth.currentUser?.uid;
  const productIds: string[] = [];
  const userIds: string[] = [];
  const matchIdSet = new Set<string>();
  const nonParticipantMatchIds: string[] = [];

  matchDocs.forEach((d) => {
    const data = d.data();
    matchIdSet.add(d.id);
    if (data.target_product_id) productIds.push(String(data.target_product_id));
    if (data.offered_product_id) productIds.push(String(data.offered_product_id));
    const ownerId = data.owner_id ? String(data.owner_id) : '';
    const requesterId = data.requester_id ? String(data.requester_id) : '';
    if (ownerId) userIds.push(ownerId);
    if (requesterId) userIds.push(requesterId);
    if (!currentUid || (ownerId !== currentUid && requesterId !== currentUid)) {
      nonParticipantMatchIds.push(d.id);
    }
  });

  const [
    maps,
    profiles,
    images,
    productSnaps,
    myConvSnaps,
    myExSnaps,
    myConfSnaps,
    modConvSnaps,
    modExSnaps,
  ] = await Promise.all([
    fetchLookupMaps(),
    fetchProfilesMap(userIds),
    fetchImagesByProductIds(productIds),
    Promise.all(
      Array.from(new Set(productIds)).map((pid) =>
        getDoc(doc(db, 'products', pid)).catch(() => null)
      )
    ),
    currentUid
      ? Promise.all([
          getDocs(
            query(collection(db, 'conversations'), where('participant_a', '==', currentUid))
          ).catch(() => null),
          getDocs(
            query(collection(db, 'conversations'), where('participant_b', '==', currentUid))
          ).catch(() => null),
        ])
      : Promise.resolve([null, null]),
    currentUid
      ? Promise.all([
          getDocs(query(collection(db, 'exchanges'), where('owner_id', '==', currentUid))).catch(
            () => null
          ),
          getDocs(
            query(collection(db, 'exchanges'), where('requester_id', '==', currentUid))
          ).catch(() => null),
        ])
      : Promise.resolve([null, null]),
    currentUid
      ? Promise.all([
          getDocs(
            query(collection(db, 'exchange_confirmations'), where('owner_id', '==', currentUid))
          ).catch(() => null),
          getDocs(
            query(collection(db, 'exchange_confirmations'), where('requester_id', '==', currentUid))
          ).catch(() => null),
        ])
      : Promise.resolve([null, null]),
    Promise.all(
      nonParticipantMatchIds.map((mid) =>
        getDocs(query(collection(db, 'conversations'), where('match_id', '==', mid))).catch(
          () => null
        )
      )
    ),
    Promise.all(
      nonParticipantMatchIds.map((mid) =>
        getDocs(query(collection(db, 'exchanges'), where('match_id', '==', mid))).catch(
          () => null
        )
      )
    ),
  ]);

  const productMap = new Map<string, Product>();
  productSnaps.forEach((pSnap) => {
    if (pSnap?.exists()) {
      productMap.set(
        pSnap.id,
        hydrateProductDoc(pSnap.id, pSnap.data(), { ...maps, profiles, images })
      );
    }
  });

  const convDocMap = new Map<string, { id: string; data: () => Record<string, unknown> }>();
  [...myConvSnaps, ...modConvSnaps].forEach((snap) => {
    snap?.docs.forEach((cDoc) => {
      if (matchIdSet.has(String(cDoc.data().match_id || ''))) {
        convDocMap.set(cDoc.id, cDoc);
      }
    });
  });

  const convByMatch = new Map<string, Conversation[]>();
  convDocMap.forEach((cDoc) => {
    const d = cDoc.data();
    const mid = String(d.match_id || '');
    const list = convByMatch.get(mid) ?? [];
    list.push({
      id: cDoc.id,
      match_id: mid,
      participant_a: String(d.participant_a || ''),
      participant_b: String(d.participant_b || ''),
      is_blocked: Boolean(d.is_blocked),
      blocked_by: d.blocked_by ? String(d.blocked_by) : null,
      created_at: toIsoString(d.created_at),
    });
    convByMatch.set(mid, list);
  });

  const exDocMap = new Map<string, { id: string; data: () => Record<string, unknown> }>();
  [...myExSnaps, ...modExSnaps].forEach((snap) => {
    snap?.docs.forEach((eDoc) => {
      if (matchIdSet.has(String(eDoc.data().match_id || ''))) {
        exDocMap.set(eDoc.id, eDoc);
      }
    });
  });

  const nonParticipantExIds: string[] = [];
  const exByMatch = new Map<string, ExchangeRecord[]>();
  exDocMap.forEach((eDoc) => {
    const d = eDoc.data();
    const mid = String(d.match_id || '');
    if (
      !currentUid ||
      (String(d.owner_id || '') !== currentUid && String(d.requester_id || '') !== currentUid)
    ) {
      nonParticipantExIds.push(eDoc.id);
    }
    const list = exByMatch.get(mid) ?? [];
    list.push({
      id: eDoc.id,
      match_id: mid,
      status: d.status as ExchangeRecord['status'],
      proposed_date: d.proposed_date ? String(d.proposed_date) : null,
      proposed_time_slot: d.proposed_time_slot ? String(d.proposed_time_slot) : null,
      meeting_point_label: d.meeting_point_label ? String(d.meeting_point_label) : null,
      meeting_point_lat: typeof d.meeting_point_lat === 'number' ? d.meeting_point_lat : null,
      meeting_point_lng: typeof d.meeting_point_lng === 'number' ? d.meeting_point_lng : null,
      proposed_by: d.proposed_by ? String(d.proposed_by) : null,
      cancelled_by: d.cancelled_by ? String(d.cancelled_by) : null,
      cancellation_reason: d.cancellation_reason ? String(d.cancellation_reason) : null,
      completed_at: toNullableIsoString(d.completed_at),
      created_at: toIsoString(d.created_at),
      exchange_confirmations: [],
    });
    exByMatch.set(mid, list);
  });

  const modConfSnaps = await Promise.all(
    nonParticipantExIds.map((exId) =>
      getDocs(
        query(collection(db, 'exchange_confirmations'), where('exchange_id', '==', exId))
      ).catch(() => null)
    )
  );

  const confDocMap = new Map<string, { id: string; data: () => Record<string, unknown> }>();
  [...myConfSnaps, ...modConfSnaps].forEach((snap) => {
    snap?.docs.forEach((cDoc) => {
      const exId = String(cDoc.data().exchange_id || '');
      if (exDocMap.has(exId)) {
        confDocMap.set(cDoc.id, cDoc);
      }
    });
  });

  const confByEx = new Map<string, ExchangeConfirmation[]>();
  confDocMap.forEach((c) => {
    const cd = c.data();
    const exId = String(cd.exchange_id || '');
    const list = confByEx.get(exId) ?? [];
    list.push({
      id: c.id,
      exchange_id: exId,
      user_id: String(cd.user_id || ''),
      confirmed_at: toIsoString(cd.confirmed_at),
      notes: cd.notes ? String(cd.notes) : null,
    });
    confByEx.set(exId, list);
  });

  exByMatch.forEach((list) => {
    list.forEach((ex) => {
      ex.exchange_confirmations = confByEx.get(ex.id) ?? [];
    });
  });

  return matchDocs
    .map((mDoc) => {
      const d = mDoc.data();
      return {
        id: mDoc.id,
        request_id: String(d.request_id || ''),
        target_product_id: String(d.target_product_id || ''),
        offered_product_id: d.offered_product_id ? String(d.offered_product_id) : null,
        owner_id: String(d.owner_id || ''),
        requester_id: String(d.requester_id || ''),
        modality: d.modality as ProductModality,
        quantity_reserved: Number(d.quantity_reserved ?? 1),
        status: d.status as MatchRecord['status'],
        created_at: toIsoString(d.created_at),
        target_product: productMap.get(String(d.target_product_id || '')) ?? null,
        offered_product: d.offered_product_id
          ? productMap.get(String(d.offered_product_id)) ?? null
          : null,
        owner: profiles.get(String(d.owner_id || '')) ?? null,
        requester: profiles.get(String(d.requester_id || '')) ?? null,
        conversations: convByMatch.get(mDoc.id) ?? [],
        exchanges: exByMatch.get(mDoc.id) ?? [],
      } satisfies MatchRecord;
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export async function listUserMatches(userId: string): Promise<MatchRecord[]> {
  try {
    const [asOwnerSnap, asRequesterSnap] = await Promise.all([
      getDocs(query(collection(db, 'matches'), where('owner_id', '==', userId))),
      getDocs(query(collection(db, 'matches'), where('requester_id', '==', userId))),
    ]);

    const docMap = new Map<string, (typeof asOwnerSnap.docs)[number]>();
    asOwnerSnap.docs.forEach((d) => docMap.set(d.id, d));
    asRequesterSnap.docs.forEach((d) => docMap.set(d.id, d));
    return hydrateMatchDocs(Array.from(docMap.values()));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'matches');
  }
}

export async function getMatchDetail(matchId: string): Promise<MatchRecord | null> {
  try {
    const snap = await getDoc(doc(db, 'matches', matchId)).catch(() => null);
    if (snap?.exists()) {
      const hydrated = await hydrateMatchDocs([snap]);
      return hydrated[0] ?? null;
    }

    // Respaldo para enlaces /matches/match_{requestId} o IDs legados del usuario autenticado
    const currentUid = auth.currentUser?.uid;
    if (currentUid) {
      const reqIdCandidate = matchId.startsWith('match_') ? matchId.slice(6) : matchId;
      const [asOwnerSnap, asRequesterSnap] = await Promise.all([
        getDocs(query(collection(db, 'matches'), where('owner_id', '==', currentUid))),
        getDocs(query(collection(db, 'matches'), where('requester_id', '==', currentUid))),
      ]);
      const fallbackDoc =
        asOwnerSnap.docs.find(
          (d) => d.id === matchId || String(d.data().request_id || '') === reqIdCandidate
        ) ??
        asRequesterSnap.docs.find(
          (d) => d.id === matchId || String(d.data().request_id || '') === reqIdCandidate
        );
      if (fallbackDoc) {
        const hydrated = await hydrateMatchDocs([fallbackDoc]);
        return hydrated[0] ?? null;
      }
    }

    return null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `matches/${matchId}`);
  }
}

export function subscribeUserMatchActivity(
  userId: string,
  onChange: () => void
): () => void {
  let first = [true, true, true, true];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const trigger = (idx: number) => {
    if (first[idx]) {
      first[idx] = false;
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  };

  const unsubs = [
    onSnapshot(
      query(collection(db, 'match_requests'), where('owner_id', '==', userId)),
      () => trigger(0),
      () => {}
    ),
    onSnapshot(
      query(collection(db, 'match_requests'), where('requester_id', '==', userId)),
      () => trigger(1),
      () => {}
    ),
    onSnapshot(
      query(collection(db, 'matches'), where('owner_id', '==', userId)),
      () => trigger(2),
      () => {}
    ),
    onSnapshot(
      query(collection(db, 'matches'), where('requester_id', '==', userId)),
      () => trigger(3),
      () => {}
    ),
  ];

  return () => {
    if (timer) clearTimeout(timer);
    unsubs.forEach((u) => u());
  };
}
