import { Capacitor } from '@capacitor/core';
import {
  GoogleAuthProvider,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  deleteUser,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  updatePassword,
  updateProfile,
  type User,
} from 'firebase/auth';
import {
  deleteDoc,
  doc,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import {
  ENABLE_CLOUD_FUNCTIONS,
  auth,
  db,
  functions,
  handleFirestoreError,
  OperationType,
  storage,
  toIsoString,
} from './firebase';
import { mapProfileDoc } from './firestoreHelpers';
import type { AccountType, PrivateContact, Profile, UserRole } from '../types/domain';

import { fileToCompactDataUrl } from '../utils/imageOptimizer';

const BOOTSTRAP_SUPER_ADMIN_EMAILS = new Set([
  'claudionaourlopez@gmail.com',
  'naourclaudio@gmail.com',
  'businessnaourgroup@gmail.com',
]);

const bootstrapInFlight = new Map<string, Promise<void>>();
const pendingRegistrationsByEmail = new Map<string, Promise<void>>();
let pendingGoogleDefaults: BootstrapProfileDetails | undefined;

export interface BootstrapProfileDetails {
  accountType?: AccountType;
  institutionName?: string;
  institutionDescription?: string;
  responsiblePerson?: string;
  institutionalCode?: string;
  communeId?: string;
  sectorId?: string;
  privatePhone?: string;
}

export interface RegisterPayload {
  email: string;
  password: string;
  fullName: string;
  username: string;
  communeId: string;
  sectorId?: string;
  accountType: AccountType;
  institutionName?: string;
  institutionDescription?: string;
  responsiblePerson?: string;
  institutionalCode?: string;
  privatePhone?: string;
  isMinorSupervised?: boolean;
  guardianAuthorizationNote?: string;
}

async function resolveTerritorialLabels(communeId?: string | null, sectorId?: string | null) {
  let communeName: string | null = null;
  let communeRegion: string | null = null;
  let sectorName: string | null = null;

  if (communeId) {
    const cSnap = await getDoc(doc(db, 'communes', communeId)).catch(() => null);
    if (cSnap?.exists()) {
      communeName = String(cSnap.data().name || '');
      communeRegion = String(cSnap.data().region || '');
    }
  }
  if (sectorId) {
    const sSnap = await getDoc(doc(db, 'sectors', sectorId)).catch(() => null);
    if (sSnap?.exists()) {
      sectorName = String(sSnap.data().name || '');
    }
  }
  return { communeName, communeRegion, sectorName };
}

export async function initializeUserDocuments(
  firebaseUser: User,
  details: {
    fullName: string;
    username: string;
    communeId?: string | null;
    sectorId?: string | null;
    accountType?: AccountType;
    institutionName?: string;
    institutionDescription?: string;
    responsiblePerson?: string;
    institutionalCode?: string;
    privatePhone?: string;
    isMinorSupervised?: boolean;
    guardianAuthorizationNote?: string;
  }
): Promise<void> {
  const uid = firebaseUser.uid;
  const userRef = doc(db, 'users', uid);
  const treeRef = doc(db, 'user_tree_progress', uid);
  const [existing, treeExisting] = await Promise.all([
    getDoc(userRef),
    getDoc(treeRef).catch(() => null),
  ]);
  if (existing.exists()) return;

  const { communeName, communeRegion, sectorName } = await resolveTerritorialLabels(
    details.communeId,
    details.sectorId
  );

  const normalizedUsername = details.username
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.\-]/g, '_')
    .slice(0, 50);

  const safeUsername =
    normalizedUsername.length >= 3
      ? normalizedUsername
      : `vecino_${uid.slice(0, 6)}`;

  const cleanFullName = details.fullName.trim();
  const safeFullName =
    cleanFullName.length >= 2 ? cleanFullName.slice(0, 120) : 'Participante PoliCircular';

  const clampOpt = (val: string | undefined, max: number): string | null => {
    const trimmed = val?.trim();
    return trimmed ? trimmed.slice(0, max) : null;
  };

  const batch = writeBatch(db);
  batch.set(userRef, {
    id: uid,
    full_name: safeFullName,
    username: safeUsername,
    avatar_url: firebaseUser.photoURL ? firebaseUser.photoURL.slice(0, 2000) : null,
    bio: null,
    commune_id: details.communeId || 'castro',
    commune_name: (communeName || 'Castro').slice(0, 100),
    commune_region: (communeRegion || 'Región de Los Lagos').slice(0, 100),
    sector_id: details.sectorId || null,
    sector_name: sectorName ? sectorName.slice(0, 120) : null,
    account_type: details.accountType || 'individual',
    institution_id: null,
    institution_name: clampOpt(details.institutionName, 160),
    institution_description: clampOpt(details.institutionDescription, 500),
    responsible_person: clampOpt(details.responsiblePerson, 120),
    institutional_code: clampOpt(details.institutionalCode, 60),
    is_minor_supervised: Boolean(details.isMinorSupervised),
    guardian_authorization_note: clampOpt(details.guardianAuthorizationNote, 240),
    is_suspended: false,
    suspension_reason: null,
    reputation_avg: 0,
    reputation_count: 0,
    terms_accepted_at: serverTimestamp(),
    created_at: serverTimestamp(),
    updated_at: serverTimestamp(),
  });

  batch.set(doc(db, 'users', uid, 'private', 'contact'), {
    user_id: uid,
    private_email: clampOpt(firebaseUser.email || undefined, 200),
    private_phone: clampOpt(details.privatePhone, 40),
    updated_at: serverTimestamp(),
  });

  if (!treeExisting?.exists()) {
    batch.set(treeRef, {
      user_id: uid,
      completed_operations: 0,
      completed_gifts: 0,
      completed_exchanges: 0,
      current_stage: 'semilla',
      updated_at: serverTimestamp(),
    });
  }

  await batch.commit();
}

const PUBLIC_WEB_ORIGIN = 'https://ais-pre-dj7zeddnfchgopwqeu36fl-839173396062.us-east1.run.app';

function getAuthContinueBaseUrl(): string {
  const origin = Capacitor.isNativePlatform() ? PUBLIC_WEB_ORIGIN : window.location.origin;
  const basePath = import.meta.env.BASE_URL || '/';
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return `${origin}${normalizedBase}`;
}

export async function registerUser(payload: RegisterPayload) {
  const emailKey = payload.email.trim().toLowerCase();
  let resolveReg!: () => void;
  const regPromise = new Promise<void>((resolve) => {
    resolveReg = resolve;
  });
  pendingRegistrationsByEmail.set(emailKey, regPromise);

  try {
    const credential = await createUserWithEmailAndPassword(
      auth,
      payload.email.trim(),
      payload.password
    );
    const firebaseUser = credential.user;

    await updateProfile(firebaseUser, {
      displayName: payload.fullName.trim().slice(0, 120),
    }).catch(() => {});

    await initializeUserDocuments(firebaseUser, {
      fullName: payload.fullName,
      username: payload.username,
      communeId: payload.communeId,
      sectorId: payload.sectorId,
      accountType: payload.accountType,
      institutionName: payload.institutionName,
      institutionDescription: payload.institutionDescription,
      responsiblePerson: payload.responsiblePerson,
      institutionalCode: payload.institutionalCode,
      privatePhone: payload.privatePhone,
      isMinorSupervised: payload.isMinorSupervised,
      guardianAuthorizationNote: payload.guardianAuthorizationNote,
    });

    return { user: firebaseUser };
  } finally {
    resolveReg();
    pendingRegistrationsByEmail.delete(emailKey);
  }
}

export async function signInUser(email: string, password: string) {
  const credential = await signInWithEmailAndPassword(auth, email.trim(), password);
  void ensureBootstrapProfile(credential.user).catch((err) => {
    console.warn('No se pudo inicializar perfil tras login:', err);
  });
  return { user: credential.user };
}

export async function signInWithGoogle(defaults?: BootstrapProfileDetails): Promise<User> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  pendingGoogleDefaults = defaults;
  try {
    const result = await signInWithPopup(auth, provider);
    await ensureBootstrapProfile(result.user, defaults).catch((err) => {
      console.warn('No se pudo inicializar perfil tras Google login:', err);
    });
    return result.user;
  } finally {
    pendingGoogleDefaults = undefined;
  }
}

export async function ensureBootstrapProfile(
  firebaseUser: User,
  defaults?: BootstrapProfileDetails
): Promise<void> {
  const emailKey = (firebaseUser.email || '').trim().toLowerCase();
  const pendingReg = emailKey ? pendingRegistrationsByEmail.get(emailKey) : undefined;
  if (pendingReg) {
    await pendingReg;
  }

  const existingPromise = bootstrapInFlight.get(firebaseUser.uid);
  if (existingPromise) {
    return existingPromise;
  }

  const effectiveDefaults = defaults ?? pendingGoogleDefaults;

  const task = (async () => {
    const userRef = doc(db, 'users', firebaseUser.uid);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      const emailPrefix = (firebaseUser.email || 'vecino').split('@')[0];
      await initializeUserDocuments(firebaseUser, {
        fullName: firebaseUser.displayName || emailPrefix,
        username: `${emailPrefix}_${firebaseUser.uid.slice(0, 4)}`,
        communeId: effectiveDefaults?.communeId || 'castro',
        sectorId: effectiveDefaults?.sectorId,
        accountType: effectiveDefaults?.accountType || 'individual',
        institutionName: effectiveDefaults?.institutionName,
        institutionDescription: effectiveDefaults?.institutionDescription,
        responsiblePerson: effectiveDefaults?.responsiblePerson,
        institutionalCode: effectiveDefaults?.institutionalCode,
        privatePhone: effectiveDefaults?.privatePhone,
      });
    }
  })();

  bootstrapInFlight.set(firebaseUser.uid, task);
  try {
    await task;
  } finally {
    bootstrapInFlight.delete(firebaseUser.uid);
  }
}

export async function resendVerificationEmail(): Promise<void> {
  const current = auth.currentUser;
  if (!current) {
    throw new Error('Inicia sesión primero para reenviar el correo de verificación.');
  }
  await sendEmailVerification(current, {
    url: `${getAuthContinueBaseUrl()}iniciar-sesion`,
  });
}

export async function signOutUser(): Promise<void> {
  await signOut(auth);
}

export async function sendPasswordRecovery(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim(), {
    url: `${getAuthContinueBaseUrl()}restablecer-contrasena`,
  });
}

export async function confirmPasswordResetWithCode(
  oobCode: string,
  newPassword: string
): Promise<void> {
  await confirmPasswordReset(auth, oobCode, newPassword);
}

export async function updateUserPassword(newPassword: string): Promise<void> {
  const current = auth.currentUser;
  if (!current) throw new Error('No hay una sesión activa.');
  await updatePassword(current, newPassword);
}

export async function fetchUserProfile(userId: string): Promise<Profile | null> {
  try {
    const snap = await getDoc(doc(db, 'users', userId));
    if (!snap.exists()) return null;
    const profile = mapProfileDoc(snap.id, snap.data());

    if (profile.commune_id && !profile.communes) {
      const cSnap = await getDoc(doc(db, 'communes', profile.commune_id)).catch(() => null);
      if (cSnap?.exists()) {
        profile.communes = {
          id: cSnap.id,
          name: String(cSnap.data().name || ''),
          region: String(cSnap.data().region || ''),
        };
      }
    }
    if (profile.sector_id && !profile.sectors) {
      const sSnap = await getDoc(doc(db, 'sectors', profile.sector_id)).catch(() => null);
      if (sSnap?.exists()) {
        profile.sectors = {
          id: sSnap.id,
          name: String(sSnap.data().name || ''),
          approx_lat: typeof sSnap.data().approx_lat === 'number' ? sSnap.data().approx_lat : null,
          approx_lng: typeof sSnap.data().approx_lng === 'number' ? sSnap.data().approx_lng : null,
        };
      }
    }

    return profile;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `users/${userId}`);
  }
}

export async function fetchUserRoles(
  userId: string,
  email?: string | null
): Promise<UserRole[]> {
  if (email && BOOTSTRAP_SUPER_ADMIN_EMAILS.has(email.toLowerCase())) {
    return ['user', 'moderator', 'admin', 'super_admin'];
  }
  try {
    const snap = await getDoc(doc(db, 'user_roles', userId));
    if (!snap.exists()) return ['user'];
    const roles = (snap.data().roles as UserRole[] | undefined) || ['user'];
    return roles.length > 0 ? roles : ['user'];
  } catch {
    return ['user'];
  }
}

export async function fetchPrivateContact(userId: string): Promise<PrivateContact | null> {
  try {
    const snap = await getDoc(doc(db, 'users', userId, 'private', 'contact'));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      user_id: userId,
      private_email: d.private_email ? String(d.private_email) : null,
      private_phone: d.private_phone ? String(d.private_phone) : null,
      updated_at: toIsoString(d.updated_at),
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `users/${userId}/private/contact`);
  }
}

export async function updateOwnProfile(
  userId: string,
  updates: Partial<{
    full_name: string;
    bio: string | null;
    commune_id: string | null;
    sector_id: string | null;
    avatar_url: string | null;
    institution_name: string | null;
    institution_description: string | null;
    responsible_person: string | null;
    institutional_code: string | null;
  }>,
  privatePhone?: string | null
): Promise<void> {
  const territorial =
    updates.commune_id !== undefined || updates.sector_id !== undefined
      ? await resolveTerritorialLabels(updates.commune_id, updates.sector_id)
      : null;

  const payload: Record<string, unknown> = {
    ...updates,
    updated_at: serverTimestamp(),
  };

  if (typeof payload.full_name === 'string') {
    payload.full_name = payload.full_name.trim().slice(0, 120);
  }
  if (typeof payload.bio === 'string') {
    payload.bio = payload.bio.trim().slice(0, 500) || null;
  }
  if (typeof payload.institution_name === 'string') {
    payload.institution_name = payload.institution_name.trim().slice(0, 160) || null;
  }
  if (typeof payload.institution_description === 'string') {
    payload.institution_description = payload.institution_description.trim().slice(0, 500) || null;
  }
  if (typeof payload.responsible_person === 'string') {
    payload.responsible_person = payload.responsible_person.trim().slice(0, 120) || null;
  }
  if (typeof payload.institutional_code === 'string') {
    payload.institutional_code = payload.institutional_code.trim().slice(0, 60) || null;
  }

  if (territorial) {
    if (updates.commune_id !== undefined) {
      payload.commune_name = territorial.communeName ? territorial.communeName.slice(0, 100) : null;
      payload.commune_region = territorial.communeRegion ? territorial.communeRegion.slice(0, 100) : null;
    }
    if (updates.sector_id !== undefined) {
      payload.sector_name = territorial.sectorName ? territorial.sectorName.slice(0, 120) : null;
    }
  }

  try {
    await updateDoc(doc(db, 'users', userId), payload);

    if (privatePhone !== undefined) {
      await setDoc(
        doc(db, 'users', userId, 'private', 'contact'),
        {
          user_id: userId,
          private_phone: privatePhone ? privatePhone.trim().slice(0, 40) : null,
          updated_at: serverTimestamp(),
        },
        { merge: true }
      );
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${userId}`);
  }
}

export async function uploadAvatarImage(userId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() || 'webp';
  const filePath = `avatars/${userId}/avatar_${Date.now()}.${ext}`;
  const fileRef = ref(storage, filePath);
  try {
    await Promise.race([
      uploadBytes(fileRef, file, {
        contentType: file.type || 'image/webp',
        cacheControl: 'public,max-age=3600',
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Storage timeout')), 3500)
      ),
    ]);
    return await getDownloadURL(fileRef);
  } catch {
    return fileToCompactDataUrl(file, 256, 80_000);
  }
}

export async function deleteOwnAccount(): Promise<void> {
  const current = auth.currentUser;
  if (!current) return;

  if (ENABLE_CLOUD_FUNCTIONS) {
    const fn = httpsCallable(functions, 'deleteOwnAccount');
    await fn();
    await signOut(auth);
    return;
  }

  await updateDoc(doc(db, 'users', current.uid), {
    is_suspended: true,
    suspension_reason: 'Cuenta eliminada por el usuario',
    updated_at: serverTimestamp(),
  });
  await deleteDoc(doc(db, 'users', current.uid, 'private', 'contact')).catch(() => {});

  try {
    await deleteUser(current);
  } catch {
    // Si Firebase exige reautenticación reciente, cerramos la sesión tras desactivar el perfil
    await signOut(auth);
  }
}
