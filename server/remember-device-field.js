export const rememberDeviceStyles = `
  label.remember-device{display:flex;align-items:center;gap:10px;min-height:44px;margin:0 0 12px;font-size:14px;font-weight:500;cursor:pointer}
  .remember-device input{flex:none;width:18px;height:18px;margin:0;padding:0;accent-color:#526443}
  .remember-device input:focus-visible{outline:2px solid #526443;outline-offset:3px}
`;

export const rememberDeviceField = (checked) => `
  <label class="remember-device">
    <input type="checkbox" name="rememberDevice" value="1"${checked ? ' checked' : ''}>
    Запомнить вход на этом устройстве
  </label>`;
