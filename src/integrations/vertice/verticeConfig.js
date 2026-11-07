// Projeto Firebase do VÉRTICE (não o do GerenciaAI). Configuração de app web:
// Console do Firebase › projeto do Vértice › Configurações do projeto › Seus
// apps › App da Web. Não é segredo (vai para o navegador de qualquer forma);
// quem protege os dados são as regras do Vértice (firebase/firestore.rules lá).
//
// Enquanto `projectId` estiver vazio, a aba Configurações → Vértice explica
// que a integração ainda não foi ativada neste build e nada é carregado.
export const VERTICE_FIREBASE_CONFIG = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  appId: '',
};

export function verticeConfigurado(config = VERTICE_FIREBASE_CONFIG) {
  return !!(config && config.apiKey && config.projectId && config.appId && !/x{4}/.test(config.projectId));
}
