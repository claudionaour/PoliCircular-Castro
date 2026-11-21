import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import {
  getProductAlertSubscription,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  saveProductAlertSubscription,
  subscribeUserNotifications,
  type SaveProductAlertInput,
} from '../services/notificationService';
import { isFirebaseConfigured } from '../services/firebase';
import {
  listenForegroundPushMessages,
  registerUserPushToken,
} from '../services/messagingService';
import type { AppNotification, ProductAlertSubscription } from '../types/domain';

interface NotificationContextValue {
  notifications: AppNotification[];
  unreadCount: number;
  loading: boolean;
  alertSubscription: ProductAlertSubscription | null;
  loadingSubscription: boolean;
  latestAlert: AppNotification | null;
  dismissLatestAlert: () => void;
  refresh: () => Promise<void>;
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  saveAlertPreferences: (input: SaveProductAlertInput) => Promise<ProductAlertSubscription>;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(undefined);

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isEmailVerified } = useAuth();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [alertSubscription, setAlertSubscription] = useState<ProductAlertSubscription | null>(null);
  const [loadingSubscription, setLoadingSubscription] = useState(false);
  const [latestAlert, setLatestAlert] = useState<AppNotification | null>(null);

  const subscriptionRef = useRef<ProductAlertSubscription | null>(null);
  useEffect(() => {
    subscriptionRef.current = alertSubscription;
  }, [alertSubscription]);

  const refresh = useCallback(async () => {
    if (!user || !isFirebaseConfigured || !isEmailVerified) {
      setNotifications([]);
      setAlertSubscription(null);
      return;
    }
    setLoading(true);
    setLoadingSubscription(true);
    try {
      const [items, sub] = await Promise.all([
        listNotifications(user.uid).catch(() => []),
        getProductAlertSubscription(user.uid).catch(() => null),
      ]);
      setNotifications(items);
      setAlertSubscription(sub);
    } finally {
      setLoading(false);
      setLoadingSubscription(false);
    }
  }, [user, isEmailVerified]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!user || !isFirebaseConfigured || !isEmailVerified) {
      setLatestAlert(null);
      return;
    }

    const channel = subscribeUserNotifications(user.uid, (incoming, isRealtime) => {
      setNotifications((prev) => {
        if (prev.some((n) => n.id === incoming.id)) return prev;
        return [incoming, ...prev]
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .slice(0, 60);
      });

      if (isRealtime && !incoming.is_read) {
        setLatestAlert(incoming);
        if (
          subscriptionRef.current?.browser_notifications &&
          typeof window !== 'undefined' &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          try {
            new Notification(incoming.title, {
              body: incoming.body,
              icon: '/pwa-192x192.png',
            });
          } catch {
            // Ignorar si el navegador restringe el constructor Notification directo
          }
        }
      }
    });

    registerUserPushToken(user.uid).catch(() => {});
    let unsubForeground = () => {};
    listenForegroundPushMessages(() => {
      refresh().catch(() => {});
    }).then((fn) => {
      unsubForeground = fn;
    });

    return () => {
      channel.unsubscribe();
      unsubForeground();
    };
  }, [user, isEmailVerified, refresh]);

  const markAsRead = useCallback(async (id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, is_read: true } : n))
    );
    setLatestAlert((prev) => (prev?.id === id ? null : prev));
    await markNotificationRead(id);
  }, []);

  const markAllAsRead = useCallback(async () => {
    if (!user) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
    setLatestAlert(null);
    await markAllNotificationsRead(user.uid);
  }, [user]);

  const dismissLatestAlert = useCallback(() => {
    setLatestAlert(null);
  }, []);

  const saveAlertPreferences = useCallback(
    async (input: SaveProductAlertInput) => {
      if (!user) {
        throw new Error('Inicia sesión para guardar tus alertas.');
      }
      const saved = await saveProductAlertSubscription(user.uid, input);
      setAlertSubscription(saved);
      return saved;
    },
    [user]
  );

  const unreadCount = notifications.filter((n) => !n.is_read).length;

  return (
    <NotificationContext.Provider
      value={{
        notifications,
        unreadCount,
        loading,
        alertSubscription,
        loadingSubscription,
        latestAlert,
        dismissLatestAlert,
        refresh,
        markAsRead,
        markAllAsRead,
        saveAlertPreferences,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
};

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications debe usarse dentro de NotificationProvider.');
  }
  return ctx;
}
