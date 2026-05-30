# Guardar+

Aplicativo de controle financeiro feito em React + Vite.

## Rodar no computador

```bash
npm install
npm run app
```

Abra:

```text
http://localhost:5173
```

Esse modo roda o frontend e a API local com banco SQLite.

## Hospedar grátis no GitHub Pages

O projeto já está pronto para GitHub Pages com o arquivo:

```text
.github/workflows/deploy.yml
```

Passos:

1. Crie um repositório no GitHub.
2. Envie estes arquivos para o repositório.
3. No GitHub, abra `Settings > Pages`.
4. Em `Build and deployment`, escolha `GitHub Actions`.
5. Faça push na branch `main`.
6. Abra a aba `Actions` e espere o workflow `Deploy to GitHub Pages` terminar.

O site será publicado em uma URL parecida com:

```text
https://seu-usuario.github.io/nome-do-repositorio/
```

## Importante sobre banco de dados

GitHub Pages hospeda apenas site estático. Ele não roda a API Node nem o SQLite.

Por isso, quando estiver no GitHub Pages sem uma API online configurada, o app usa modo local:

- login e cadastro ficam salvos apenas no navegador da pessoa;
- os gastos e investimentos ficam no `localStorage`;
- a IA de mercado mostra dados educativos e avisa que cotações atuais precisam de API.

Para ter banco real e mais de um login sincronizado entre celulares/computadores, hospede a API em outro serviço e configure:

```env
VITE_API_URL=https://sua-api-online.com
```

Depois rode o build novamente ou configure essa variável nos secrets/env do seu host.
