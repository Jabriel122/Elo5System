app.post('/api/login', async (req, res) => {
  const { email, senha } = req.body;
  const DOMINIO_PERMITIDO = '@suaempresa.com';

  // 1. Verifica se o e-mail termina com o domínio exigido
  if (!email || !email.toLowerCase().endsWith(DOMINIO_PERMITIDO)) {
    return res.status(403).json({ 
      erro: 'Acesso negado. Utilize um e-mail corporativo válido.' 
    });
  }

  // 2. Prossegue com a verificação de senha / banco de dados...
});