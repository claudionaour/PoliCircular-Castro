import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, loading, profile } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-sm text-slate-200">Verificando sesión...</div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/iniciar-sesion" state={{ from: location.pathname }} replace />;
  }

  if (profile?.is_suspended) {
    return (
      <div className="max-w-lg mx-auto my-12 p-6 rounded-2xl border border-red-400/40 bg-red-950/70 text-red-100">
        <h2 className="font-display text-lg font-bold">Cuenta suspendida temporalmente</h2>
        <p className="mt-2 text-sm">
          {profile.suspension_reason ||
            'Tu cuenta se encuentra suspendida mientras la moderación revisa un reporte.'}
        </p>
      </div>
    );
  }

  return <>{children}</>;
};

export const AdminRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, loading, isModerator } = useAuth();

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-sm text-slate-200">Verificando permisos administrativos...</div>
      </div>
    );
  }

  if (!user || !isModerator) {
    return <Navigate to="/inicio" replace />;
  }

  return <>{children}</>;
};
