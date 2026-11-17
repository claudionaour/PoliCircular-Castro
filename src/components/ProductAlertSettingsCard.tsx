import React, { useEffect, useState } from 'react';
import { Bell, BellRing, Check, Plus, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationContext';
import { listActiveCommunes, listCategories } from '../services/territorialService';
import type { Category, Commune, ProductModality } from '../types/domain';

interface ProductAlertSettingsCardProps {
  initialCategoryId?: string;
  initialCommuneId?: string;
  initialModality?: 'all' | ProductModality;
  compact?: boolean;
  onSaved?: () => void;
}

export const ProductAlertSettingsCard: React.FC<ProductAlertSettingsCardProps> = ({
  initialCategoryId,
  initialCommuneId,
  initialModality,
  compact = false,
  onSaved,
}) => {
  const { user, isEmailVerified } = useAuth();
  const { alertSubscription, loadingSubscription, saveAlertPreferences } = useNotifications();

  const [categories, setCategories] = useState<Category[]>([]);
  const [communes, setCommunes] = useState<Commune[]>([]);

  const [enabled, setEnabled] = useState(true);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [communeId, setCommuneId] = useState('');
  const [modality, setModality] = useState<'all' | ProductModality>('all');
  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState('');
  const [browserNotifications, setBrowserNotifications] = useState(false);

  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    Promise.all([listCategories(), listActiveCommunes()])
      .then(([cats, comms]) => {
        setCategories(cats);
        setCommunes(comms);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (alertSubscription) {
      setEnabled(alertSubscription.enabled);
      setSelectedCategories(alertSubscription.category_ids);
      setCommuneId(alertSubscription.commune_id || '');
      setModality(alertSubscription.modality);
      setKeywords(alertSubscription.keywords);
      setBrowserNotifications(alertSubscription.browser_notifications);
    } else {
      setEnabled(true);
      setSelectedCategories(initialCategoryId ? [initialCategoryId] : []);
      setCommuneId(initialCommuneId || '');
      setModality(initialModality || 'all');
      setKeywords([]);
      setBrowserNotifications(false);
    }
  }, [alertSubscription, initialCategoryId, initialCommuneId, initialModality]);

  const toggleCategory = (catId: string) => {
    setSelectedCategories((prev) =>
      prev.includes(catId) ? prev.filter((id) => id !== catId) : [...prev, catId].slice(0, 20)
    );
  };

  const addKeyword = () => {
    const clean = keywordInput.trim();
    if (!clean || keywords.length >= 10) return;
    if (!keywords.some((k) => k.toLowerCase() === clean.toLowerCase())) {
      setKeywords((prev) => [...prev, clean.slice(0, 50)]);
    }
    setKeywordInput('');
  };

  const removeKeyword = (kw: string) => {
    setKeywords((prev) => prev.filter((k) => k !== kw));
  };

  const handleBrowserToggle = async (nextChecked: boolean) => {
    if (!nextChecked) {
      setBrowserNotifications(false);
      return;
    }
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setFeedback({
        type: 'err',
        text: 'Tu navegador no soporta notificaciones de escritorio; seguirás recibiéndolas dentro de la app.',
      });
      return;
    }
    if (Notification.permission === 'granted') {
      setBrowserNotifications(true);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      setBrowserNotifications(true);
      setFeedback(null);
    } else {
      setBrowserNotifications(false);
      setFeedback({
        type: 'err',
        text: 'Permiso de navegador denegado. Seguirás recibiendo todas las alertas en tu bandeja de PoliCircular.',
      });
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !isEmailVerified) {
      setFeedback({
        type: 'err',
        text: 'Inicia sesión con una cuenta verificada para guardar alertas.',
      });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      await saveAlertPreferences({
        enabled,
        categoryIds: selectedCategories,
        communeId: communeId || null,
        modality,
        keywords,
        browserNotifications,
      });
      setFeedback({
        type: 'ok',
        text: enabled
          ? 'Alertas guardadas. Te avisaremos en tiempo real apenas se publique un nuevo producto compatible.'
          : 'Alertas pausadas. Puedes reactivarlas cuando quieras.',
      });
      onSaved?.();
    } catch (err) {
      setFeedback({
        type: 'err',
        text: err instanceof Error ? err.message : 'No se pudieron guardar tus preferencias.',
      });
    } finally {
      setSaving(false);
    }
  };

  if (!user) return null;

  return (
    <form
      onSubmit={handleSave}
      className="rounded-2xl bg-[#102C49] border border-[#244B73] p-5 sm:p-6 space-y-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-xl bg-[#0B1E33] border border-[#244B73] flex items-center justify-center text-[#FFA94D] shrink-0">
            {enabled ? <BellRing className="h-5 w-5" /> : <Bell className="h-5 w-5 text-slate-400" />}
          </div>
          <div>
            <h2 className="font-display font-bold text-base text-white">
              Alertas de nuevos productos publicados
            </h2>
            <p className="text-xs text-slate-200">
              Recibe una notificación inmediata cada vez que alguien publique un artículo de tu interés.
            </p>
          </div>
        </div>

        <label className="inline-flex items-center gap-2.5 cursor-pointer self-start sm:self-center">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 accent-[#F28C28] rounded"
          />
          <span className="text-xs font-semibold text-white">
            {enabled ? 'Alertas activadas' : 'Alertas desactivadas'}
          </span>
        </label>
      </div>

      {loadingSubscription ? (
        <div className="h-20 rounded-xl bg-[#0B1E33] animate-pulse" />
      ) : (
        <div className={`space-y-4 ${enabled ? '' : 'opacity-60'}`}>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-200">
                Categorías de interés{' '}
                <span className="font-normal text-slate-400">
                  ({selectedCategories.length === 0 ? 'Todas las categorías' : `${selectedCategories.length} seleccionadas`})
                </span>
              </span>
              {selectedCategories.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedCategories([])}
                  className="text-[11px] font-semibold text-[#FFA94D] hover:underline"
                >
                  Todas las categorías
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {categories.map((cat) => {
                const active = selectedCategories.includes(cat.id);
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => toggleCategory(cat.id)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-medium border transition-colors ${
                      active
                        ? 'bg-[#F28C28] text-[#0B1E33] border-[#F28C28] font-bold'
                        : 'bg-[#0B1E33] text-slate-200 border-[#2D557F] hover:border-[#FFA94D]/60'
                    }`}
                  >
                    {cat.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className={`grid ${compact ? 'sm:grid-cols-2' : 'sm:grid-cols-3'} gap-3`}>
            <div>
              <label className="block text-xs font-semibold text-slate-200 mb-1">Comuna</label>
              <select
                value={communeId}
                onChange={(e) => setCommuneId(e.target.value)}
                className="w-full rounded-xl border border-[#2D557F] bg-[#0B1E33] text-white px-3 py-2 text-xs"
              >
                <option value="">Todas las comunas</option>
                {communes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-200 mb-1">Modalidad</label>
              <select
                value={modality}
                onChange={(e) => setModality(e.target.value as 'all' | ProductModality)}
                className="w-full rounded-xl border border-[#2D557F] bg-[#0B1E33] text-white px-3 py-2 text-xs"
              >
                <option value="all">Regalo o Intercambio</option>
                <option value="gift">Solo regalo gratuito</option>
                <option value="exchange">Solo intercambio</option>
              </select>
            </div>

            <div className={compact ? 'sm:col-span-2' : ''}>
              <label className="block text-xs font-semibold text-slate-200 mb-1">
                Palabras clave (opcional)
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={keywordInput}
                  onChange={(e) => setKeywordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addKeyword();
                    }
                  }}
                  placeholder="Ej. bicicleta, libros, madera"
                  className="flex-1 rounded-xl border border-[#2D557F] bg-[#0B1E33] text-white placeholder:text-slate-400 px-3 py-2 text-xs"
                />
                <button
                  type="button"
                  onClick={addKeyword}
                  aria-label="Agregar palabra clave"
                  className="px-3 py-2 rounded-xl border border-[#3B648F] bg-[#0B1E33] text-white hover:bg-[#163B61]"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {keywords.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {keywords.map((kw) => (
                <span
                  key={kw}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#0B1E33] border border-[#3B648F] text-xs text-slate-100"
                >
                  <span>{kw}</span>
                  <button
                    type="button"
                    onClick={() => removeKeyword(kw)}
                    aria-label={`Quitar ${kw}`}
                    className="text-slate-400 hover:text-red-300"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-[#244B73]">
            <label className="inline-flex items-center gap-2 text-xs text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={browserNotifications}
                onChange={(e) => handleBrowserToggle(e.target.checked)}
                className="h-4 w-4 accent-[#6EE7B7] rounded"
              />
              <span>Activar también avisos del navegador cuando la pestaña esté abierta</span>
            </label>

            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center justify-center gap-1.5 px-5 py-2.5 rounded-xl bg-[#F28C28] text-[#0B1E33] text-xs font-bold hover:bg-[#FFA242] disabled:opacity-50 whitespace-nowrap"
            >
              <Check className="h-4 w-4" />
              <span>{saving ? 'Guardando...' : 'Guardar preferencias de alertas'}</span>
            </button>
          </div>
        </div>
      )}

      {feedback && (
        <div
          className={`rounded-xl p-3 text-xs ${
            feedback.type === 'ok'
              ? 'bg-[#143D29] border border-[#34D399]/35 text-[#6EE7B7]'
              : 'bg-red-950/70 border border-red-400/40 text-red-200'
          }`}
        >
          {feedback.text}
        </div>
      )}
    </form>
  );
};
