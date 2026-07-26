import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const ProfileContext = createContext(null);

export function ProfileProvider({ children }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const active = await window.pdv.profile.getActive();
    setProfile(active);
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return (
    <ProfileContext.Provider value={{ profile, loading, reload }}>
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile() {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile precisa estar dentro de <ProfileProvider>');
  return ctx;
}
