document.querySelector('#login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.target.querySelector('button');
  button.disabled = true;
  try {
    const response = await fetch('/owner/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: document.querySelector('#code').value.trim() }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    location.reload();
  } catch (error) {
    document.querySelector('#error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
