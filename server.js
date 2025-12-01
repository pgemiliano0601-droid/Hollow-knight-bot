const express = require("express");
const app = express();
const port = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Bot activo.");
});

app.listen(port, () => {
  console.log(`Servidor activo en el puerto ${port}`);
});
