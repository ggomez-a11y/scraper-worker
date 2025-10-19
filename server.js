import express from 'express';

const app = express();

// simple health endpoint
app.get('/', (req, res) => {
  res.send('OK - server is running');
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`server listening on http://localhost:${PORT}`);
});

