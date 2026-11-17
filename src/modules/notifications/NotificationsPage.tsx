import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, CheckCheck, Sparkles } from 'lucide-react';
import { useNotifications } from '../../context/NotificationContext';
import { ProductAlertSettingsCard } from '../../components/ProductAlertSettingsCard';
import { formatChileDateTime } from '../../utils/formatters';

type NotifFilter = 'all' | 'new_products' | 'unread';

export const NotificationsPage: React.FC = () => {
  const { notifications, unreadCount, loading, markAsRead, markAllAsRead } = useNotifications();
  const [filter, setFilter] = useState<NotifFilter>('all');

  const filtered = useMemo(() => {
    if (filter === 'new_products') {
      return notifications.filter((n) => n.event_type === 'new_product_alert');
    }
    if (filter === 'unread') {
      return notifications.filter((n) => !n.is_read);
    }
    return notifications;
  }, [notifications, filter]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Notificaciones y Alertas</h1>
          <p className="text-sm text-slate-300 tabular-nums">
            {unreadCount} sin leer · Avisos en tiempo real de nuevos productos, solicitudes y logros
          </p>
        </div>

        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => markAllAsRead()}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-[#3B648F] bg-[#0B1E33] text-xs font-semibold text-white hover:bg-[#163B61] self-start"
          >
            <CheckCheck className="h-4 w-4 text-[#6EE7B7]" />
            <span>Marcar todas como leídas</span>
          </button>
        )}
      </div>

      {/* Configuración de alertas para nuevos productos publicados */}
      <ProductAlertSettingsCard />

      {/* Filtro del historial */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setFilter('all')}
          className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors ${
            filter === 'all'
              ? 'bg-[#F28C28] text-[#0B1E33] border-[#F28C28] font-bold'
              : 'bg-[#102C49] text-slate-200 border-[#244B73] hover:bg-[#163B61]'
          }`}
        >
          Todas ({notifications.length})
        </button>
        <button
          type="button"
          onClick={() => setFilter('new_products')}
          className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors ${
            filter === 'new_products'
              ? 'bg-[#F28C28] text-[#0B1E33] border-[#F28C28] font-bold'
              : 'bg-[#102C49] text-slate-200 border-[#244B73] hover:bg-[#163B61]'
          }`}
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span>
            Nuevos productos ({notifications.filter((n) => n.event_type === 'new_product_alert').length})
          </span>
        </button>
        <button
          type="button"
          onClick={() => setFilter('unread')}
          className={`px-3.5 py-2 rounded-xl text-xs font-semibold border transition-colors ${
            filter === 'unread'
              ? 'bg-[#F28C28] text-[#0B1E33] border-[#F28C28] font-bold'
              : 'bg-[#102C49] text-slate-200 border-[#244B73] hover:bg-[#163B61]'
          }`}
        >
          Sin leer ({unreadCount})
        </button>
      </div>

      {loading ? (
        <div className="h-32 rounded-2xl bg-[#102C49] border border-[#244B73] animate-pulse" />
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl bg-[#102C49] border border-[#244B73] p-8 text-center space-y-2">
          <Bell className="h-8 w-8 text-slate-400 mx-auto" />
          <p className="font-display font-bold text-sm text-white">Sin notificaciones en esta vista</p>
          <p className="text-xs text-slate-300">
            Activa tus alertas arriba para recibir avisos inmediatos cuando se publiquen nuevos productos de tu interés, o cuando recibas solicitudes, mensajes y logros.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl bg-[#102C49] border border-[#244B73] divide-y divide-[#244B73] overflow-hidden">
          {filtered.map((n) => (
            <div
              key={n.id}
              className={`p-4 flex items-start justify-between gap-4 ${
                n.is_read ? 'bg-[#102C49]' : 'bg-[#183B5E]'
              }`}
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-display font-bold text-sm text-white">{n.title}</h2>
                  {n.event_type === 'new_product_alert' && (
                    <span className="text-[11px] font-semibold text-[#6EE7B7] bg-[#143D29] border border-[#34D399]/35 px-2 py-0.5 rounded-md">
                      Nuevo en catálogo
                    </span>
                  )}
                  {!n.is_read && (
                    <span className="text-[11px] font-semibold text-[#FFA94D]">Nueva</span>
                  )}
                </div>
                <p className="text-xs text-slate-200">{n.body}</p>
                <p className="text-[11px] text-slate-300">{formatChileDateTime(n.created_at)}</p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {n.link_path && (
                  <Link
                    to={n.link_path}
                    onClick={() => !n.is_read && markAsRead(n.id)}
                    className="px-3 py-1.5 rounded-lg bg-[#F28C28] text-[#0B1E33] text-xs font-bold hover:bg-[#FFA242]"
                  >
                    Ver
                  </Link>
                )}
                {!n.is_read && (
                  <button
                    type="button"
                    onClick={() => markAsRead(n.id)}
                    className="text-xs font-medium text-slate-300 hover:text-white"
                  >
                    Leída
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
