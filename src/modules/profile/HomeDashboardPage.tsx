import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeftRight,
  BarChart3,
  BookOpen,
  Compass,
  Package,
  PlusCircle,
  Trees,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { listMatchRequests, listUserMatches } from '../../services/matchingService';
import { subscribeTreeProgress } from '../../services/treeImpactService';
import { TREE_STAGE_INFO } from '../../utils/formatters';
import type { UserTreeProgress } from '../../types/domain';

const PRIMARY_SECTIONS = [
  {
    to: '/matches',
    title: 'Mis Match y Chat',
    desc: 'Responde solicitudes y coordina tus retiros por chat.',
    icon: ArrowLeftRight,
  },
  {
    to: '/mis-publicaciones',
    title: 'Mis productos',
    desc: 'Gestiona tus artículos publicados y stock disponible.',
    icon: Package,
  },
  {
    to: '/mi-arbol',
    title: 'Mi Árbol Circular',
    desc: 'Sigue tu crecimiento automático e insignias obtenidas.',
    icon: Trees,
  },
  {
    to: '/impacto',
    title: 'Impacto Ambiental',
    desc: 'Revisa los kilos recuperados y cifras de la comunidad.',
    icon: BarChart3,
  },
  {
    to: '/educacion',
    title: 'Aprende a Circular',
    desc: 'Guías prácticas y desafíos de economía circular.',
    icon: BookOpen,
  },
];

export const HomeDashboardPage: React.FC = () => {
  const { user, profile } = useAuth();
  const [tree, setTree] = useState<UserTreeProgress | null>(null);
  const [pendingReceived, setPendingReceived] = useState(0);
  const [matchesCount, setMatchesCount] = useState(0);

  useEffect(() => {
    if (!user) return;
    const unsubTree = subscribeTreeProgress(user.uid, setTree);
    Promise.all([listMatchRequests(user.uid), listUserMatches(user.uid)])
      .then(([reqs, matches]) => {
        setPendingReceived(reqs.filter((r) => r.owner_id === user.uid && r.status === 'pending').length);
        setMatchesCount(matches.length);
      })
      .catch(() => {});
    return () => unsubTree();
  }, [user]);

  const stageInfo = TREE_STAGE_INFO[tree?.current_stage ?? 'semilla'];

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-[#102C49] border border-[#244B73] text-white p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div className="space-y-2">
          <p className="text-xs font-semibold text-[#FFA94D]">
            {profile?.communes?.name ? `${profile.communes.name} · ${profile.communes.region}` : 'Comunidad PoliCircular'}
          </p>
          <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-white">
            Hola, {profile?.full_name || 'Participante'}
          </h1>
          <p className="text-sm text-slate-200 max-w-xl">
            Cada Match confirma la operación al instante y hace crecer tu Árbol Circular. Etapa actual:{' '}
            <strong className="text-[#6EE7B7]">{stageInfo.label}</strong> ({tree?.completed_operations ?? 0} operaciones).
          </p>
        </div>

        <div className="flex flex-wrap gap-3 shrink-0">
          <Link
            to="/publicar"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#F28C28] text-[#0B1E33] text-sm font-bold hover:bg-[#FFA242] transition-colors whitespace-nowrap"
          >
            <PlusCircle className="h-4 w-4" />
            <span>Publicar producto</span>
          </Link>
          <Link
            to="/explorar"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-white text-[#102C49] text-sm font-semibold hover:bg-slate-100 transition-colors whitespace-nowrap"
          >
            <Compass className="h-4 w-4" />
            <span>Explorar catálogo</span>
          </Link>
        </div>
      </section>

      {/* Resumen en vivo de actividad */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Link
          to="/matches"
          className="rounded-2xl bg-[#102C49] border border-[#244B73] hover:border-[#FFA94D]/60 p-4 transition-colors"
        >
          <span className="text-xs text-slate-300 block">Solicitudes por responder</span>
          <span className="font-mono text-2xl font-bold text-[#FFA94D] tabular-nums mt-1 block">
            {pendingReceived}
          </span>
        </Link>
        <Link
          to="/matches"
          className="rounded-2xl bg-[#102C49] border border-[#244B73] hover:border-[#FFA94D]/60 p-4 transition-colors"
        >
          <span className="text-xs text-slate-300 block">Match confirmados</span>
          <span className="font-mono text-2xl font-bold text-white tabular-nums mt-1 block">
            {matchesCount}
          </span>
        </Link>
        <Link
          to="/mi-arbol"
          className="rounded-2xl bg-[#102C49] border border-[#244B73] hover:border-[#34D399]/60 p-4 transition-colors"
        >
          <span className="text-xs text-slate-300 block">Regalos completados</span>
          <span className="font-mono text-2xl font-bold text-[#6EE7B7] tabular-nums mt-1 block">
            {tree?.completed_gifts ?? 0}
          </span>
        </Link>
        <Link
          to="/mi-arbol"
          className="rounded-2xl bg-[#102C49] border border-[#244B73] hover:border-[#FFA94D]/60 p-4 transition-colors"
        >
          <span className="text-xs text-slate-300 block">Intercambios realizados</span>
          <span className="font-mono text-2xl font-bold text-white tabular-nums mt-1 block">
            {tree?.completed_exchanges ?? 0}
          </span>
        </Link>
      </section>

      <section>
        <h2 className="font-display text-lg font-bold text-white mb-4">¿Qué quieres hacer hoy?</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {PRIMARY_SECTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.to}
                to={item.to}
                className="group rounded-2xl bg-[#102C49] border border-[#244B73] p-5 hover:border-[#FFA94D]/60 transition-colors flex items-start gap-4"
              >
                <div className="h-11 w-11 rounded-xl bg-[#0B1E33] border border-[#244B73] flex items-center justify-center text-[#FFA94D] group-hover:bg-[#F28C28] group-hover:text-[#0B1E33] transition-colors shrink-0">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-display font-bold text-sm text-white">{item.title}</h3>
                  <p className="text-xs text-slate-200 leading-relaxed">{item.desc}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
};
