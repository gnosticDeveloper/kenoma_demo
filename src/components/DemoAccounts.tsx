import { useTranslation } from 'react-i18next'
import { getDb, resetDb } from '../mock/db'
import { LANG_KEY } from '../i18n'
import type { LoginRequest } from '../types'

interface Props {
  onSelect: (dto: LoginRequest) => void
  busy: boolean
}

export function DemoAccounts({ onSelect, busy }: Props) {
  const { t, i18n } = useTranslation()
  const db = getDb()

  const shops = db.orgs.map(org => ({
    org,
    owner: db.users.find(u => u.orgId === org.id),
  }))

  function handleReset() {
    if (!window.confirm(t('demo.resetConfirm'))) return
    resetDb()
    window.location.reload()
  }

  function switchLanguage(lang: 'en' | 'es') {
    if (lang === i18n.language) return
    localStorage.setItem(LANG_KEY, lang)
    i18n.changeLanguage(lang)
    resetDb()
  }

  return (
    <div className="panel demo-accounts">
      <div className="demo-accounts-header">
        <h2>{t('demo.title')}</h2>
        <div className="demo-lang-switch">
          <button
            type="button"
            className={`btn btn-sm ${i18n.language === 'en' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => switchLanguage('en')}
          >
            English
          </button>
          <button
            type="button"
            className={`btn btn-sm ${i18n.language === 'es' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => switchLanguage('es')}
          >
            Español
          </button>
        </div>
      </div>
      <p className="panel-hint">{t('demo.hint')}</p>

      <div className="demo-shop-list">
        {shops.map(({ org, owner }) => owner && (
          <button
            key={org.id}
            type="button"
            className="demo-shop"
            disabled={busy}
            onClick={() => onSelect({ orgId: org.id, username: owner.username, password: owner.password })}
          >
            <span className="demo-shop-name">{org.name}</span>
            <span className="demo-shop-owner">{t('demo.logInAs', { name: owner.name })}</span>
          </button>
        ))}
      </div>

      <div className="actions">
        <button className="btn btn-outline btn-sm" type="button" onClick={handleReset}>{t('demo.reset')}</button>
      </div>
    </div>
  )
}
