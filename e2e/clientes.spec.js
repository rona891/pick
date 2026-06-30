import { test, expect } from '@playwright/test';
import { login, irAAdminClientes } from './helpers.js';

test.describe('Admin → Clientes', () => {
  test('navegar a panel admin muestra tabla y botón nuevo', async ({ page }) => {
    await irAAdminClientes(page);
    await expect(page.locator('#clientes-table')).toBeVisible();
    await expect(page.locator('#btn-nuevo-cliente')).toBeVisible();
  });

  test('flete se pre-rellena con 8 al abrir formulario de nuevo cliente (FA)', async ({ page }) => {
    await irAAdminClientes(page);

    await page.click('#btn-nuevo-cliente');
    await expect(page.locator('#tipo-cliente-modal')).toBeVisible();

    await page.click('#btn-tipo-fa');
    await expect(page.locator('#cliente-modal')).toBeVisible();

    await expect(page.locator('#cf-flete')).toHaveValue('8');
  });

  test('flete queda vacío al abrir edición de cliente sin flete', async ({ page }) => {
    // Crear un cliente sin flete via la API usando el token del login
    await login(page);
    const token = await page.evaluate(() => localStorage.getItem('token'));
    const cod = `E2E${Date.now()}`;

    const r = await page.request.post('https://localhost:3000/api/yaguar/clientes/', {
      data: { nombre: 'E2E EDITAR FLETE', localidad: 'MERLO', vendedor: 'TEST', id_yaguar: cod },
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    if (!r.ok()) { test.skip(true, 'No se pudo crear cliente de prueba'); return; }
    const cliente = await r.json();

    // Navegar a admin clientes
    await page.click('.mayorista-card[data-mayorista="yaguar"]');
    await expect(page.locator('#app-view')).toBeVisible();
    await page.click('button[data-tab="admin"]');
    await expect(page.locator('#admin-panel')).toBeVisible();

    // Buscar el cliente creado y click en su fila
    await page.fill('#admin-clientes-search', 'E2E EDITAR FLETE');
    const fila = page.locator('#clientes-table tbody tr', { hasText: 'E2E EDITAR FLETE' }).first();
    await expect(fila).toBeVisible({ timeout: 8000 });
    await fila.click();
    await expect(page.locator('#cliente-modal')).toBeVisible();

    // Al editar con flete null, el campo queda vacío (no 8)
    await expect(page.locator('#cf-flete')).toHaveValue('');

    // Cleanup
    await page.request.delete(`https://localhost:3000/api/yaguar/clientes/${cliente.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  });
});
